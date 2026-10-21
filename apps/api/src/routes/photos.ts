import {
  extensionFor,
  idSchema,
  listPhotosQuerySchema,
  newId,
  originalKey,
  uploadUrlRequestSchema,
  type Photo,
  type PhotoPage,
  type UploadUrlResponse,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, orNotFound } from "../lib/errors";
import { validate } from "../lib/validation";
import type { Deps } from ".";
import { toPhoto } from "./present";

const photoParam = z.object({ photoId: idSchema });

export function photoRoutes(app: Hono<AppEnv>, { repos, storage, config }: Deps): void {
  /**
   * Starts an upload (FR-UP-3/4/7, NFR-SEC-6): quota check, `pending` item, pre-signed POST for
   * `users/{sub}/originals/{photoId}.{ext}`. The bytes go straight to S3; the thumbnail Lambda
   * takes it from there (ARCHITECTURE.md §8.2).
   *
   * With `photoId` (a retry, 5.6a) it re-signs the upload for that photo instead: no new item, so
   * failed or expired attempts don't leave duplicate pending photos behind.
   */
  app.post("/photos/upload-url", validate("json", uploadUrlRequestSchema), async (c) => {
    const userId = c.get("userId");
    const { fileName, contentType, sizeBytes, photoId: retryOf } = c.req.valid("json");

    // The quota covers counted photos plus every pending upload (`bytesReserved`, 5.6b).
    const usage = await repos.usage.get(userId);
    const quotaBytes = usage.quotaBytes ?? config.defaultQuotaBytes;
    const quotaExceeded = () =>
      new AppError(413, "QUOTA_EXCEEDED", "This upload would exceed your storage quota");

    if (retryOf) {
      // Other users' photos read as missing (NFR-SEC-2).
      const record = orNotFound(await repos.photos.get(userId, retryOf), "Photo not found");
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
    }

    const photoId = newId();
    const key = originalKey(userId, photoId, extensionFor(contentType));
    // Signed before the item exists, so a failure here leaves nothing behind.
    const upload = await storage.createUploadPost({ key, contentType, sizeBytes });
    // Reserves the bytes atomically with the item, so parallel requests can't overshoot.
    const created = await repos.photos.createPending(
      {
        userId,
        photoId,
        fileName,
        contentType,
        sizeBytes,
        originalKey: key,
        uploadedAt: new Date().toISOString(),
      },
      { quotaBytes },
    );
    if (created === "quota-exceeded") throw quotaExceeded();

    const body: UploadUrlResponse = { photoId, upload };
    return c.json(body, 201);
  });

  /** Own photos by date taken, newest first by default, paginated (FR-GAL-1, FR-GAL-2). */
  app.get("/photos", validate("query", listPhotosQuerySchema), async (c) => {
    const { sort, limit, cursor } = c.req.valid("query");
    const page = await repos.photos.list(c.get("userId"), { sort, limit, cursor });
    const body: PhotoPage = { items: page.items.map(toPhoto), nextCursor: page.nextCursor };
    return c.json(body);
  });

  /** One own photo. Other users' photos are 404 (NFR-SEC-2). */
  app.get("/photos/:photoId", validate("param", photoParam), async (c) => {
    const { photoId } = c.req.valid("param");
    const record = orNotFound(await repos.photos.get(c.get("userId"), photoId), "Photo not found");
    const body: Photo = toPhoto(record);
    return c.json(body);
  });
}
