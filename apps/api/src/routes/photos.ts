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
   */
  app.post("/photos/upload-url", validate("json", uploadUrlRequestSchema), async (c) => {
    const userId = c.get("userId");
    const { fileName, contentType, sizeBytes } = c.req.valid("json");

    // Counted usage only: pending uploads aren't in Usage yet, so parallel uploads can overshoot
    // the quota slightly (PROGRESS.md decisions, 2026-10-19).
    const usage = await repos.usage.get(userId);
    const quotaBytes = usage.quotaBytes ?? config.defaultQuotaBytes;
    if (usage.bytesUsed + sizeBytes > quotaBytes) {
      throw new AppError(413, "QUOTA_EXCEEDED", "This upload would exceed your storage quota");
    }

    const photoId = newId();
    const key = originalKey(userId, photoId, extensionFor(contentType));
    // Signed before the item exists, so a failure here leaves nothing behind.
    const upload = await storage.createUploadPost({ key, contentType, sizeBytes });
    await repos.photos.createPending({
      userId,
      photoId,
      fileName,
      contentType,
      sizeBytes,
      originalKey: key,
      uploadedAt: new Date().toISOString(),
    });

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
