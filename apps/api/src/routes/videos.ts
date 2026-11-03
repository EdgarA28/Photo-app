import {
  MULTIPART_PART_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  completeVideoUploadRequestSchema,
  extensionFor,
  idSchema,
  newId,
  originalKey,
  startVideoUploadRequestSchema,
  videoPartCount,
  videoPartsRequestSchema,
  type CompleteVideoUploadResponse,
  type StartVideoUploadResponse,
  type VideoPartsResponse,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, orNotFound, quotaExceeded, validationError } from "../lib/errors";
import { log } from "../lib/log";
import { validate } from "../lib/validation";
import type { PhotoRecord } from "../repo";
import type { Deps } from ".";

const photoParam = z.object({ photoId: idSchema });

/** Size of part `partNumber` (1-based) of a video of `sizeBytes`: all full except the last. */
export function partSize(sizeBytes: number, partNumber: number): number {
  return Math.min(MULTIPART_PART_BYTES, sizeBytes - (partNumber - 1) * MULTIPART_PART_BYTES);
}

const stillPending = (record: PhotoRecord) => record.status === "pending";

/**
 * Video uploads (§9, FR-VID-1–3, 14.2): the browser sends the file to S3 itself, in parts of
 * `MULTIPART_PART_BYTES` (ARCHITECTURE.md §10.2). The item is an ordinary pending Photo item with
 * `mediaType: video` and the multipart `uploadId`; the video service (14.3) takes it from there
 * like the thumbnail Lambda does for photos. Cancel = `DELETE /photos/{id}` (aborts the upload).
 */
export function videoRoutes(app: Hono<AppEnv>, { repos, storage, config }: Deps): void {
  /** The caller's video by ID; other users' photos, and photos, read as missing (NFR-SEC-2). */
  async function ownVideo(userId: string, photoId: string): Promise<PhotoRecord> {
    const record = await repos.photos.get(userId, photoId);
    return orNotFound(record?.mediaType === "video" ? record : null, "Video not found");
  }

  /**
   * Starts a video upload: the same quota reservation, pending item and pending marker (6.11) as
   * `upload-url` (FR-VID-3), plus `CreateMultipartUpload`.
   */
  app.post("/videos/uploads", validate("json", startVideoUploadRequestSchema), async (c) => {
    const userId = c.get("userId");
    const { fileName, contentType, sizeBytes } = c.req.valid("json");
    const usage = await repos.usage.get(userId);
    const quotaBytes = usage.quotaBytes ?? config.defaultQuotaBytes;
    // Saves starting an S3 upload that can't fit; the transaction below is the real check.
    if (usage.bytesReserved + sizeBytes > quotaBytes) throw quotaExceeded();

    const photoId = newId();
    const key = originalKey(userId, photoId, extensionFor(contentType));
    const uploadId = await storage.createMultipartUpload({ key, contentType });
    let created: Awaited<ReturnType<typeof repos.photos.createPending>>;
    try {
      created = await repos.photos.createPending(
        {
          userId,
          photoId,
          fileName,
          contentType,
          sizeBytes,
          originalKey: key,
          uploadedAt: new Date().toISOString(),
          mediaType: "video",
          uploadId,
        },
        { quotaBytes },
      );
    } catch (err) {
      await storage.abortMultipartUpload({ key, uploadId });
      throw err;
    }
    if (created === "quota-exceeded") {
      await storage.abortMultipartUpload({ key, uploadId });
      throw quotaExceeded();
    }
    const body: StartVideoUploadResponse = {
      photoId,
      uploadId,
      partBytes: MULTIPART_PART_BYTES,
      partCount: videoPartCount(sizeBytes),
    };
    return c.json(body, 201);
  });

  /**
   * Part URLs for an upload in progress, also again when earlier ones expired (15 min). Each is
   * pinned to its part's exact size, so the parts can't add up to more than the declared size.
   */
  app.post(
    "/videos/:photoId/parts",
    validate("param", photoParam),
    validate("json", videoPartsRequestSchema),
    async (c) => {
      const userId = c.get("userId");
      const record = await ownVideo(userId, c.req.valid("param").photoId);
      if (!stillPending(record) || !record.uploadId) {
        throw new AppError(409, "CONFLICT", "This video has already been uploaded");
      }
      const partCount = videoPartCount(record.sizeBytes);
      const { partNumbers } = c.req.valid("json");
      if (partNumbers.some((n) => n > partCount)) {
        throw validationError(`This video has ${partCount} parts`);
      }
      // Before signing, so the URLs live at least until then.
      const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
      const parts = await storage.createUploadPartUrls(
        { key: record.originalKey, uploadId: record.uploadId },
        partNumbers.map((partNumber) => ({
          partNumber,
          sizeBytes: partSize(record.sizeBytes, partNumber),
        })),
      );
      const body: VideoPartsResponse = { parts, expiresAt };
      return c.json(body);
    },
  );

  /**
   * Finishes the upload: `CompleteMultipartUpload` with every part, then the stored size must be
   * the declared one (the part URLs pin each part's size, so this is a second guard; it replaces
   * the POST policy's `content-length-range` of photos). A wrong size deletes the object and the
   * photo (its reservation is released) and answers 400. Repeating a successful complete is fine.
   */
  app.post(
    "/videos/:photoId/complete",
    validate("param", photoParam),
    validate("json", completeVideoUploadRequestSchema),
    async (c) => {
      const userId = c.get("userId");
      const record = await ownVideo(userId, c.req.valid("param").photoId);
      const done: CompleteVideoUploadResponse = { photoId: record.photoId };
      // Completed before (the item lost its uploadId, or is processed already).
      if (!stillPending(record) || !record.uploadId) return c.json(done);

      const partCount = videoPartCount(record.sizeBytes);
      const { parts } = c.req.valid("json");
      // Distinct numbers (schema) and exactly as many as the video has, all in range: 1…partCount.
      if (parts.length !== partCount || parts.some((p) => p.partNumber > partCount)) {
        throw validationError(`Send all ${partCount} parts of this video`);
      }
      const upload = { key: record.originalKey, uploadId: record.uploadId };
      const result = await storage.completeMultipartUpload(upload, parts);
      if (result === "invalid-parts") {
        throw validationError("The parts don't match what was uploaded");
      }
      // `no-such-upload`: a parallel complete got there first (the object exists), or the upload
      // was aborted (no object).
      const size = await storage.objectSize(record.originalKey);
      if (size === null) {
        throw new AppError(409, "CONFLICT", "This upload no longer exists; start it again");
      }
      if (size !== record.sizeBytes) {
        // Nothing counted it yet, so deleting it like a cancelled upload keeps Usage right.
        await storage.deleteObjects([record.originalKey]);
        const deleted = await repos.photos.delete(userId, record.photoId, stillPending);
        log("WARN", "Video upload with the wrong size removed", {
          userId,
          photoId: record.photoId,
          declared: record.sizeBytes,
          stored: size,
          deleted: deleted !== null,
        });
        throw validationError("The uploaded video doesn't have the declared size");
      }
      if (!(await repos.photos.markUploaded(userId, record.photoId, record.uploadId))) {
        // Deleted meanwhile (cancel, or the stale-pending sweep): its new original must not stay
        // behind uncounted. A parallel complete also clears uploadId, but leaves the photo.
        if (!(await repos.photos.get(userId, record.photoId))) {
          await storage.deleteObjects([record.originalKey]);
          throw new AppError(409, "CONFLICT", "This video was deleted while uploading");
        }
      }
      return c.json(done);
    },
  );
}
