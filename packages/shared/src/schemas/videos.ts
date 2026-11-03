/**
 * Video multipart upload routes (§9, FR-VID-1–3, 14.2). A video is too big for one pre-signed
 * POST, so the browser uploads it to S3 in parts of `MULTIPART_PART_BYTES`:
 *
 *   POST /videos/uploads            start: quota reserved, pending item, CreateMultipartUpload
 *   POST /videos/{photoId}/parts    pre-signed UploadPart URLs (asked again when they expire)
 *   POST /videos/{photoId}/complete CompleteMultipartUpload + size check
 *
 * Cancelling is `DELETE /photos/{photoId}` (aborts the multipart upload).
 */
import { z } from "zod";
import {
  MAX_PARTS_PER_SIGN_REQUEST,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_PARTS,
  MULTIPART_PART_BYTES,
} from "../constants";
import { idSchema, isoDateTimeSchema } from "./common";
import { fileNameSchema, videoContentTypeSchema } from "./photos";

/** Parts a video of this size is uploaded in (the last one may be smaller). */
export function videoPartCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / MULTIPART_PART_BYTES);
}

/** S3 part numbers start at 1; a video of `MAX_VIDEO_BYTES` has `MAX_VIDEO_PARTS`. */
export const partNumberSchema = z.number().int().min(1).max(MAX_VIDEO_PARTS);

const unique = (numbers: number[]) => new Set(numbers).size === numbers.length;

/** POST /videos/uploads */
export const startVideoUploadRequestSchema = z.object({
  fileName: fileNameSchema,
  contentType: videoContentTypeSchema,
  sizeBytes: z.number().int().positive().max(MAX_VIDEO_BYTES),
});
export type StartVideoUploadRequest = z.infer<typeof startVideoUploadRequestSchema>;

/** 201: the new pending item and how to split the file (`partCount` = `videoPartCount(sizeBytes)`). */
export const startVideoUploadResponseSchema = z.object({
  photoId: idSchema,
  /** S3's multipart upload ID (not the client queue ID of `upload-url`). */
  uploadId: z.string().min(1),
  partBytes: z.number().int().positive(),
  partCount: partNumberSchema,
});
export type StartVideoUploadResponse = z.infer<typeof startVideoUploadResponseSchema>;

/** POST /videos/{photoId}/parts: the parts still to upload, up to 100 per request. */
export const videoPartsRequestSchema = z.object({
  partNumbers: z
    .array(partNumberSchema)
    .min(1)
    .max(MAX_PARTS_PER_SIGN_REQUEST)
    .refine(unique, "Duplicate part numbers"),
});
export type VideoPartsRequest = z.infer<typeof videoPartsRequestSchema>;

/** One pre-signed `PUT` URL per requested part, in request order, valid until `expiresAt`. */
export const videoPartsResponseSchema = z.object({
  parts: z.array(z.object({ partNumber: partNumberSchema, url: z.url() })),
  expiresAt: isoDateTimeSchema,
});
export type VideoPartsResponse = z.infer<typeof videoPartsResponseSchema>;

/**
 * POST /videos/{photoId}/complete: every part with the `ETag` S3 returned for it (the bucket's CORS
 * exposes it). Any order; the API sorts them, as S3 wants them ascending.
 */
export const completeVideoUploadRequestSchema = z.object({
  parts: z
    .array(z.object({ partNumber: partNumberSchema, etag: z.string().min(1).max(256) }))
    .min(1)
    .max(MAX_VIDEO_PARTS)
    .refine((parts) => unique(parts.map((p) => p.partNumber)), "Duplicate part numbers"),
});
export type CompleteVideoUploadRequest = z.infer<typeof completeVideoUploadRequestSchema>;

/** 200: stored with the declared size; the video service processes it next (status `pending`). */
export const completeVideoUploadResponseSchema = z.object({ photoId: idSchema });
export type CompleteVideoUploadResponse = z.infer<typeof completeVideoUploadResponseSchema>;
