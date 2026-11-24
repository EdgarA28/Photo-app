import {
  DOWNLOAD_URL_TTL_SECONDS,
  downloadUrlQuerySchema,
  getPhotoQuerySchema,
  extensionFor,
  idSchema,
  galleryQuerySchema,
  timelineQuerySchema,
  type Timeline,
  DUPLICATE_KEY_REGEX,
  dismissDuplicatesRequestSchema,
  type Duplicates,
  newId,
  originalKey,
  uploadUrlRequestSchema,
  type DownloadUrlResponse,
  type Photo,
  type PhotoPage,
  type UploadUrlResponse,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, notFound, orNotFound, quotaExceeded, validationError } from "../lib/errors";
import { duplicateKey, findDuplicates } from "../lib/duplicates";
import { abortUpload, objectKeys } from "../lib/objects";
import { validate } from "../lib/validation";
import type { PhotoRecord } from "../repo";
import type { Deps } from ".";
import { albumPhoto } from "./access";
import { toPhoto, toSharedPhoto } from "./present";

const photoParam = z.object({ photoId: idSchema });
const duplicateParam = z.object({ key: z.string().regex(DUPLICATE_KEY_REGEX) });

/** Newest first, then by upload: the order a group's photos are shown in. */
const byTaken = (a: PhotoRecord, b: PhotoRecord) =>
  b.takenAt.localeCompare(a.takenAt) ||
  b.uploadedAt.localeCompare(a.uploadedAt) ||
  a.photoId.localeCompare(b.photoId);

export function photoRoutes(app: Hono<AppEnv>, { repos, storage, media, config }: Deps): void {
  /**
   * Starts an upload (FR-UP-3/4/7, NFR-SEC-6): quota check, `pending` item, pre-signed POST for
   * `users/{sub}/originals/{photoId}.{ext}`. The bytes go straight to S3; the thumbnail Lambda
   * takes it from there (ARCHITECTURE.md §8.2).
   *
   * With `photoId` (a retry, 5.6a) it re-signs the upload for that photo instead: no new item, so
   * failed or expired attempts don't leave duplicate pending photos behind. `uploadId` (the
   * client's queue ID for the file) finds that photo when the client never got to store its
   * `photoId`, e.g. the app was closed right after the request.
   */
  app.post("/photos/upload-url", validate("json", uploadUrlRequestSchema), async (c) => {
    const userId = c.get("userId");
    const { fileName, contentType, sizeBytes, photoId: retryOf, uploadId } = c.req.valid("json");

    // The quota covers counted photos plus every pending upload (`bytesReserved`, 5.6b).
    const usage = await repos.usage.get(userId);
    const quotaBytes = usage.quotaBytes ?? config.defaultQuotaBytes;

    const resign = async (record: PhotoRecord) => {
      // Once processed, the original must not be replaced.
      if (record.status !== "pending") {
        throw new AppError(409, "CONFLICT", "This photo has already been uploaded");
      }
      // The quota check and the item were made for this type and size.
      if (record.contentType !== contentType || record.sizeBytes !== sizeBytes) {
        throw new AppError(409, "CONFLICT", "contentType and sizeBytes must match the photo");
      }
      // Its bytes are already reserved, so this only fails if the quota was lowered meanwhile.
      if (usage.bytesReserved > quotaBytes) throw quotaExceeded();
      const upload = await storage.createUploadPost({
        key: record.originalKey,
        contentType,
        sizeBytes,
      });
      const body: UploadUrlResponse = { photoId: record.photoId, upload };
      return c.json(body);
    };

    if (retryOf) {
      // Other users' photos read as missing (NFR-SEC-2).
      return resign(orNotFound(await repos.photos.get(userId, retryOf), "Photo not found"));
    }
    const claimed = uploadId && (await repos.photos.claimed(userId, uploadId));
    if (claimed) return resign(claimed);

    const photoId = newId();
    const key = originalKey(userId, photoId, extensionFor(contentType));
    // Signed before the item exists, so a failure here leaves nothing behind.
    const upload = await storage.createUploadPost({ key, contentType, sizeBytes });
    // Reserves the bytes atomically with the item, so parallel requests can't overshoot.
    const pending = {
      userId,
      photoId,
      fileName,
      contentType,
      sizeBytes,
      originalKey: key,
      uploadedAt: new Date().toISOString(),
    };
    let created = await repos.photos.createPending(pending, { quotaBytes, uploadId });
    if (created === "claimed") {
      // A parallel request with this uploadId won: re-sign its photo.
      const winner = await repos.photos.claimed(userId, uploadId!);
      if (winner) return resign(winner);
      // That photo was deleted meanwhile: a new one, without the claim.
      created = await repos.photos.createPending(pending, { quotaBytes });
    }
    if (created === "quota-exceeded") throw quotaExceeded();

    const body: UploadUrlResponse = { photoId, upload };
    return c.json(body, 201);
  });

  /**
   * Own photos by date taken, newest first by default, paginated (FR-GAL-1, FR-GAL-2): the
   * Gallery's photos, or with `?mediaType=video` the Videos section (FR-VID-11).
   */
  app.get("/photos", validate("query", galleryQuerySchema), async (c) => {
    const { sort, limit, cursor, mediaType, start, direction } = c.req.valid("query");
    const page = await repos.photos.list(c.get("userId"), {
      sort,
      limit,
      cursor,
      mediaType,
      start,
      direction,
    });
    const body: PhotoPage = {
      items: page.items.map(toPhoto),
      nextCursor: page.nextCursor,
      prevCursor: page.prevCursor,
    };
    return c.json(body);
  });

  /**
   * Months of the Gallery (or the Videos section) with their counts, newest first, for the
   * timeline scrubber (8.36, FR-GAL-9). The caller's own list only (keyed by the JWT sub).
   * Registered before `/photos/:photoId`, which would read "timeline" as an ID.
   */
  app.get("/photos/timeline", validate("query", timelineQuerySchema), async (c) => {
    const { mediaType, utcOffset } = c.req.valid("query");
    const body: Timeline = {
      months: await repos.photos.monthCounts(c.get("userId"), { mediaType, utcOffset }),
    };
    return c.json(body);
  });

  /**
   * The caller's duplicate groups (8.37f, FR-GAL-12, §9): ready photos (not videos, not in the
   * trash) with the same original (`originalETag`) or a hash at most 3 bits apart, whenever taken;
   * largest groups first, then the newest; dismissed groups left out. Own photos only (keyed by
   * the JWT sub). Registered before `/photos/:photoId`, which would read "duplicates" as an ID.
   */
  app.get("/photos/duplicates", async (c) => {
    const userId = c.get("userId");
    const groups = findDuplicates(await repos.photos.listDuplicateCandidates(userId));
    const records = new Map(
      (
        await repos.photos.getMany(
          userId,
          groups.flatMap((g) => g.photoIds),
        )
      ).map((r) => [r.photoId, r]),
    );
    const shown = groups
      .map(({ key, photoIds }) => ({
        key,
        photos: photoIds
          .map((id) => records.get(id))
          .filter((r): r is PhotoRecord => r !== undefined)
          .sort(byTaken),
      }))
      // Deleted between the two reads: a group needs two photos.
      .filter((group) => group.photos.length > 1)
      .sort(
        (a, b) =>
          b.photos.length - a.photos.length ||
          b.photos[0]!.takenAt.localeCompare(a.photos[0]!.takenAt),
      );
    const body: Duplicates = {
      groups: shown.map(({ key, photos }) => ({ key, photos: photos.map(toPhoto) })),
    };
    return c.json(body);
  });

  /**
   * "Not duplicates" (8.37f, FR-GAL-12): `photoIds` are the group as shown, `key` its key. A photo
   * that isn't the caller's (or is gone) → 404 (NFR-SEC-2); the group changed since it was shown
   * (a copy added, deleted or restored) → 409, so the user sees the new one first; else each photo
   * gets `dupDismissed = key` → 204.
   */
  app.post(
    "/photos/duplicates/:key/dismiss",
    validate("param", duplicateParam),
    validate("json", dismissDuplicatesRequestSchema),
    async (c) => {
      const userId = c.get("userId");
      const { key } = c.req.valid("param");
      const photoIds = [...new Set(c.req.valid("json").photoIds)];
      if (duplicateKey(photoIds) !== key) {
        throw validationError("photoIds don't match the group's key");
      }
      const records = await repos.photos.getMany(userId, photoIds);
      if (records.length !== photoIds.length) throw notFound("Photo not found");
      const groups = findDuplicates(await repos.photos.listDuplicateCandidates(userId));
      if (!groups.some((group) => group.key === key)) {
        throw new AppError(409, "CONFLICT", "This group of duplicates has changed");
      }
      if (!(await repos.photos.dismissDuplicates(userId, photoIds, key))) {
        throw new AppError(409, "CONFLICT", "This group of duplicates has changed");
      }
      return c.body(null, 204);
    },
  );

  /**
   * One own photo, or with `?albumId=` someone else's photo in that album if the caller owns it or
   * it is shared with them (5.13 rule, FR-SHR-11), with signed thumb and preview URLs (7.4) and
   * who added it. Anything else is 404 (NFR-SEC-2).
   */
  app.get(
    "/photos/:photoId",
    validate("param", photoParam),
    validate("query", getPhotoQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { photoId } = c.req.valid("param");
      const { albumId } = c.req.valid("query");
      const own = await repos.photos.get(userId, photoId);
      if (own) return c.json(toPhoto(own) satisfies Photo);
      const shared = albumId ? await albumPhoto(repos, userId, albumId, photoId) : null;
      const { photo: record, album } = orNotFound(shared, "Photo not found");
      const usernames = await repos.usernames.getMany([record.userId]);
      const body: Photo = await toSharedPhoto(record, media, new Date(), {
        preview: true,
        ownerUsername: usernames.get(record.userId) ?? null,
        withPlace: album.showLocations === true,
      });
      return c.json(body);
    },
  );

  /**
   * Makes an own ready photo its stack's top pick (8.37b, FR-GAL-11) → 204. The web app decides
   * what the stack is (§12.3); this only records the choice. Someone else's photo, a video, a
   * photo not ready or in the trash → 404 (NFR-SEC-2).
   */
  app.post("/photos/:photoId/top-pick", validate("param", photoParam), async (c) => {
    const { photoId } = c.req.valid("param");
    const done = await repos.photos.setTopPick(c.get("userId"), photoId, new Date());
    if (!done) throw notFound("Photo not found");
    return c.body(null, 204);
  });

  /**
   * Download of an original under its file name (FR-DL-1/2): 5-min pre-signed GET with
   * `Content-Disposition: attachment`, so the browser fetches it straight from S3. Own photos, or
   * with `?albumId=` someone else's photo in that album if the caller owns it or it is shared with
   * them (5.13, FR-SHR-11).
   */
  app.get(
    "/photos/:photoId/download-url",
    validate("param", photoParam),
    validate("query", downloadUrlQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { photoId } = c.req.valid("param");
      const { albumId } = c.req.valid("query");
      const own = await repos.photos.get(userId, photoId);
      const shared = !own && albumId ? await albumPhoto(repos, userId, albumId, photoId) : null;
      const record = orNotFound(own ?? shared?.photo, "Photo not found");
      // Until the upload is processed there may be no original yet. Failed photos keep theirs.
      if (record.status === "pending") {
        throw new AppError(409, "CONFLICT", "This photo has not been uploaded yet");
      }
      const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString();
      const url = await storage.createDownloadUrl({
        key: record.originalKey,
        fileName: record.fileName,
      });
      const body: DownloadUrlResponse = { url, expiresAt };
      return c.json(body);
    },
  );

  /**
   * Deletes an own photo (FR-DEL-1/3): a ready or failed photo goes to the trash for 15 days
   * (`repos.photos.trash`; restore and delete forever under /trash). An upload still pending has
   * nothing to restore, so it is deleted at once: original, thumb and preview (a video's upload is
   * aborted first), then the item, its
   * album memberships and its Usage (`repos.photos.delete`). Objects go first: if the item delete
   * then fails, a retry still finds the photo and finishes, whereas the other order could leave
   * unreferenced files behind. 204 also when it vanished meanwhile (a concurrent delete), or was
   * in the trash already.
   */
  app.delete("/photos/:photoId", validate("param", photoParam), async (c) => {
    const userId = c.get("userId");
    const { photoId } = c.req.valid("param");
    const trashed = orNotFound(
      await repos.photos.trash(userId, photoId, new Date()),
      "Photo not found",
    );
    if (trashed !== "pending") return c.body(null, 204);

    const record = orNotFound(await repos.photos.get(userId, photoId), "Photo not found");
    // A video still uploading: cancel the multipart upload first (FR-VID-2), so no part lands
    // after the delete.
    await abortUpload(storage, record);
    const keys = objectKeys(record);
    await storage.deleteObjects(keys);
    const deleted = await repos.photos.delete(userId, photoId);
    // The thumbnail Lambda finished in between and wrote thumb and preview after our delete.
    // (Had it finished after the item was gone, it would have removed them itself.) Its original
    // is gone, so it is deleted rather than trashed.
    if (deleted && deleted.status !== record.status) await storage.deleteObjects(keys);
    return c.body(null, 204);
  });
}
