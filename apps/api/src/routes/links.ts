import {
  DOWNLOAD_URL_TTL_SECONDS,
  PHOTO_LINK_TTL_SECONDS,
  idSchema,
  photoLinkTokenSchema,
  previewKey,
  type DownloadUrlResponse,
  type LinkedPhoto,
  type PhotoLink,
} from "@photo-app/shared";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, orNotFound } from "../lib/errors";
import { validate } from "../lib/validation";
import type { LinkRecord, PhotoRecord, Repositories } from "../repo";
import type { Deps } from ".";

const photoParam = z.object({ photoId: idSchema });
const tokenParam = z.object({ token: photoLinkTokenSchema });

/** A photo that can be linked: processed (it has a preview) and not in the trash. */
const linkable = (photo: PhotoRecord | null): photo is PhotoRecord =>
  photo !== null && photo.status === "ready" && photo.trashedAt === undefined;

/**
 * Public photo links (FR-SHR-8). The owner creates one (signed in); anyone with the link sees the
 * preview and can download the original for 15 minutes, without an account. The link checks the
 * photo again on every request, so a deleted or trashed photo stops working at once.
 */
export function linkRoutes(app: Hono<AppEnv>, { repos }: Deps): void {
  app.post("/photos/:photoId/links", validate("param", photoParam), async (c) => {
    const ownerId = c.get("userId");
    const { photoId } = c.req.valid("param");
    // Other users' photos read as missing (NFR-SEC-2).
    const photo = orNotFound(await repos.photos.get(ownerId, photoId), "Photo not found");
    if (!linkable(photo)) {
      throw new AppError(409, "CONFLICT", "Only processed photos outside the trash can be shared");
    }
    const now = new Date();
    const link: LinkRecord = {
      token: randomBytes(16).toString("base64url"),
      ownerId,
      photoId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PHOTO_LINK_TTL_SECONDS * 1000).toISOString(),
    };
    await repos.links.create(link);
    const body: PhotoLink = {
      token: link.token,
      path: `/s/${link.token}`,
      expiresAt: link.expiresAt,
    };
    return c.json(body, 201);
  });
}

/** The unauthenticated side, registered before the login check (`createApp` `publicRoutes`). */
export function publicLinkRoutes(app: Hono<AppEnv>, { repos, storage, media }: Deps): void {
  /** The preview, signed only until the link expires. Unknown, expired or gone → 404. */
  app.get("/links/:token", validate("param", tokenParam), async (c) => {
    const now = new Date();
    const { link, photo } = await linkedPhoto(repos, c.req.valid("param").token, now);
    const body: LinkedPhoto = {
      photoId: photo.photoId,
      previewUrl: await media.signUrl(
        `/${previewKey(photo.userId, photo.photoId)}`,
        now,
        new Date(link.expiresAt),
      ),
      width: photo.width ?? null,
      height: photo.height ?? null,
      expiresAt: link.expiresAt,
    };
    return c.json(body);
  });

  /** The original under its file name (FR-DL-2), a 5-min pre-signed GET like the owner's. */
  app.get("/links/:token/download-url", validate("param", tokenParam), async (c) => {
    const { photo } = await linkedPhoto(repos, c.req.valid("param").token, new Date());
    const url = await storage.createDownloadUrl({
      key: photo.originalKey,
      fileName: photo.fileName,
    });
    const body: DownloadUrlResponse = {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
    return c.json(body);
  });
}

async function linkedPhoto(repos: Repositories, token: string, now: Date) {
  const link = orNotFound(await repos.links.getActive(token, now), "Link not found or expired");
  const photo = await repos.photos.get(link.ownerId, link.photoId);
  if (!linkable(photo)) throw new AppError(404, "NOT_FOUND", "Link not found or expired");
  return { link, photo };
}
