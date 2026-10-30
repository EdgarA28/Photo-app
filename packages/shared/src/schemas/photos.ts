import { z } from "zod";
import { ALLOWED_CONTENT_TYPES, MAX_FILE_NAME_LENGTH, MAX_UPLOAD_BYTES } from "../constants";
import { idSchema, isoDateTimeSchema, pageQuerySchema, pageSchema, userIdSchema } from "./common";
import { photoPlaceSchema } from "./places";

export const photoStatusSchema = z.enum(["pending", "ready", "failed"]);
export type PhotoStatus = z.infer<typeof photoStatusSchema>;

export const contentTypeSchema = z.enum(ALLOWED_CONTENT_TYPES);

/** A photo as returned by the API. Image URLs are null until the photo is `ready`. */
export const photoSchema = z.object({
  photoId: idSchema,
  status: photoStatusSchema,
  fileName: z.string(),
  contentType: contentTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** EXIF DateTimeOriginal, falling back to upload time (§8.2). */
  takenAt: isoDateTimeSchema,
  uploadedAt: isoDateTimeSchema,
  /**
   * Where it was taken (13.2); null without GPS, and always for share recipients. Missing (an API
   * from before 13.2) reads as null.
   */
  place: photoPlaceSchema.nullable().default(null),
  /** Stable CloudFront path for own photos, signed URL for shared ones (§9). */
  thumbUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  /**
   * Set while the photo is in the trash (FR-DEL-3): when it was deleted and when the daily purge
   * removes it for good. Missing (an API from before the trash) reads as null.
   */
  trashedAt: isoDateTimeSchema.nullable().default(null),
  purgeAt: isoDateTimeSchema.nullable().default(null),
  /**
   * Whose photo it is: in a shared album, photos can come from the owner or from members who
   * added their own (FR-SHR-9). Missing (an API from before FR-SHR-9) reads as null.
   */
  ownerId: userIdSchema.nullable().default(null),
});
export type Photo = z.infer<typeof photoSchema>;

export const photoSortSchema = z.enum(["taken-desc", "taken-asc"]);
export type PhotoSort = z.infer<typeof photoSortSchema>;

/** GET /photos */
export const listPhotosQuerySchema = pageQuerySchema.extend({
  sort: photoSortSchema.default("taken-desc"),
});
export type ListPhotosQuery = z.infer<typeof listPhotosQuerySchema>;
export const photoPageSchema = pageSchema(photoSchema);
export type PhotoPage = z.infer<typeof photoPageSchema>;

/** GET /trash: own photos in the trash, most recently deleted first, in one response (FR-DEL-3). */
export const trashListSchema = z.object({ items: z.array(photoSchema) });
export type TrashList = z.infer<typeof trashListSchema>;

/** POST /photos/upload-url (FR-UP-2, FR-UP-3, NFR-SEC-6) */
export const uploadUrlRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(MAX_FILE_NAME_LENGTH),
  contentType: contentTypeSchema,
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  /**
   * Retry of an earlier upload (5.6a): re-sign for this still-pending photo instead of creating a
   * new one. contentType and sizeBytes must match it; fileName is kept from the first request.
   */
  photoId: idSchema.optional(),
  /**
   * The client's queue ID for the file: a repeated request with it gets the photo the first one
   * created, re-signed, e.g. when the app closed before it could store that photoId.
   */
  uploadId: z.uuid().optional(),
});
export type UploadUrlRequest = z.infer<typeof uploadUrlRequestSchema>;

export const uploadUrlResponseSchema = z.object({
  photoId: idSchema,
  upload: z.object({
    url: z.url(),
    fields: z.record(z.string(), z.string()),
  }),
});
export type UploadUrlResponse = z.infer<typeof uploadUrlResponseSchema>;

/**
 * GET /photos/{photoId}/download-url query. `albumId` names the shared album the photo is seen in:
 * recipients must pass it, because a photo is found through the album shared with them (§8.2).
 */
export const downloadUrlQuerySchema = z.object({ albumId: idSchema.optional() });
export type DownloadUrlQuery = z.infer<typeof downloadUrlQuerySchema>;

/**
 * GET /photos/{photoId} query, the same rule: with `albumId`, a photo of an album shared with the
 * caller. That is how the viewer gets a shared photo's signed preview URL (7.4).
 */
export const getPhotoQuerySchema = downloadUrlQuerySchema;
export type GetPhotoQuery = z.infer<typeof getPhotoQuerySchema>;

/** GET /photos/{photoId}/download-url (FR-DL-1, FR-DL-2) */
export const downloadUrlResponseSchema = z.object({
  url: z.url(),
  expiresAt: isoDateTimeSchema,
});
export type DownloadUrlResponse = z.infer<typeof downloadUrlResponseSchema>;
