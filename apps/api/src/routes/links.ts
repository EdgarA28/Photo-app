import {
  DOWNLOAD_URL_TTL_SECONDS,
  PHOTO_LINK_TTL_SECONDS,
  createPhotoLinkRequestSchema,
  idSchema,
  photoLinkTokenSchema,
  previewKey,
  thumbKey,
  type DownloadUrlResponse,
  type PhotoLink,
  type SharedLink,
} from "@photo-app/shared";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validation";
import type { LinkRecord, PhotoRecord, Repositories } from "../repo";
import type { Deps } from ".";

const tokenParam = z.object({ token: photoLinkTokenSchema });
const photoParam = tokenParam.extend({ photoId: idSchema });

/** A photo that can be linked: processed (it has a preview) and not in the trash. */
const linkable = (photo: PhotoRecord) => photo.status === "ready" && photo.trashedAt === undefined;
const newestFirst = (a: PhotoRecord, b: PhotoRecord) =>
  b.takenAt.localeCompare(a.takenAt) || b.photoId.localeCompare(a.photoId);

const gone = () => new AppError(404, "NOT_FOUND", "Link not found or expired");

/**
 * Public photo links (FR-SHR-8). The owner creates one for some of their photos (signed in);
 * anyone with the link sees them and can download the originals for 15 minutes, without an
 * account. Every request checks the photos again, so deleted or trashed ones drop out at once.
 */
export function linkRoutes(app: Hono<AppEnv>, { repos }: Deps): void {
  /**
   * The caller's photos among `photoIds` that can be shared go into the link; others' photos,
   * unknown ones, uploads still processing and trashed ones are left out (`photoCount` says how
   * many made it). None left → 404 when none is the caller's (NFR-SEC-2), else 409.
   */
  app.post("/links", validate("json", createPhotoLinkRequestSchema), async (c) => {
    const ownerId = c.get("userId");
    const own = await repos.photos.getMany(ownerId, c.req.valid("json").photoIds);
    if (own.length === 0) throw new AppError(404, "NOT_FOUND", "Photo not found");
    const photos = own.filter(linkable).sort(newestFirst);
    if (photos.length === 0) {
      throw new AppError(409, "CONFLICT", "Only processed photos outside the trash can be shared");
    }
    const now = new Date();
    const link: LinkRecord = {
      token: randomBytes(16).toString("base64url"),
      ownerId,
      photoIds: photos.map((photo) => photo.photoId),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PHOTO_LINK_TTL_SECONDS * 1000).toISOString(),
    };
    await repos.links.create(link);
    const body: PhotoLink = {
      token: link.token,
      path: `/s/${link.token}`,
      expiresAt: link.expiresAt,
      photoCount: photos.length,
    };
    return c.json(body, 201);
  });
}

/** The unauthenticated side, registered before the login check (`createApp` `publicRoutes`). */
export function publicLinkRoutes(app: Hono<AppEnv>, { repos, storage, media }: Deps): void {
  /**
   * The link's photos that are still there, with thumb and preview signed only until the link
   * expires. Unknown, expired, or nothing left → 404.
   */
  app.get("/links/:token", validate("param", tokenParam), async (c) => {
    const now = new Date();
    const link = await activeLink(repos, c.req.valid("param").token, now);
    const photos = (await repos.photos.getMany(link.ownerId, link.photoIds))
      .filter(linkable)
      .sort(newestFirst);
    if (photos.length === 0) throw gone();
    const until = new Date(link.expiresAt);
    const sign = (path: string) => media.signUrl(`/${path}`, now, until);
    const body: SharedLink = {
      photos: await Promise.all(
        photos.map(async (photo) => ({
          photoId: photo.photoId,
          thumbUrl: await sign(thumbKey(photo.userId, photo.photoId)),
          previewUrl: await sign(previewKey(photo.userId, photo.photoId)),
          width: photo.width ?? null,
          height: photo.height ?? null,
        })),
      ),
      expiresAt: link.expiresAt,
    };
    return c.json(body);
  });

  /** One original under its file name (FR-DL-2), a 5-min pre-signed GET like the owner's. */
  app.get(
    "/links/:token/photos/:photoId/download-url",
    validate("param", photoParam),
    async (c) => {
      const { token, photoId } = c.req.valid("param");
      const link = await activeLink(repos, token, new Date());
      // Only photos of this link, looked up under its owner.
      if (!link.photoIds.includes(photoId)) throw gone();
      const photo = await repos.photos.get(link.ownerId, photoId);
      if (!photo || !linkable(photo)) throw gone();
      const url = await storage.createDownloadUrl({
        key: photo.originalKey,
        fileName: photo.fileName,
      });
      const body: DownloadUrlResponse = {
        url,
        expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
      return c.json(body);
    },
  );
}

async function activeLink(repos: Repositories, token: string, now: Date) {
  const link = await repos.links.getActive(token, now);
  if (!link) throw gone();
  return link;
}
