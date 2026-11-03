import { z } from "zod";
import {
  MAX_FILE_NAME_LENGTH,
  MEDIA_CONTENT_TYPES,
  MEDIA_TYPES,
  PHOTO_CONTENT_TYPES,
  VIDEO_CONTENT_TYPES,
  MAX_PHOTOS_PER_SAVE_REQUEST,
  MAX_UPLOAD_BYTES,
} from "../constants";
import { idSchema, isoDateTimeSchema, pageQuerySchema, pageSchema, userIdSchema } from "./common";
import { photoPlaceSchema } from "./places";

export const photoStatusSchema = z.enum(["pending", "ready", "failed"]);
export type PhotoStatus = z.infer<typeof photoStatusSchema>;

/** Types a photo upload may have (FR-UP-2). */
export const photoContentTypeSchema = z.enum(PHOTO_CONTENT_TYPES);
/** Types a video upload may have (FR-VID-1). */
export const videoContentTypeSchema = z.enum(VIDEO_CONTENT_TYPES);
/** The type of any stored original, photo or video. */
export const mediaContentTypeSchema = z.enum(MEDIA_CONTENT_TYPES);

export const mediaTypeSchema = z.enum(MEDIA_TYPES);

/**
 * A photo or video as returned by the API (videos are Photo items too, §8.2). Image URLs are null
 * until it is `ready`; a video's are its poster frame.
 */
export const photoSchema = z.object({
  photoId: idSchema,
  status: photoStatusSchema,
  fileName: z.string(),
  /** Missing (an API from before videos, or an item from before them) reads as a photo. */
  mediaType: mediaTypeSchema.default("photo"),
  contentType: mediaContentTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /**
   * Videos once processed (FR-VID-4, FR-VID-5): length, codec of the video stream as ffprobe
   * names it (e.g. `h264`, `hevc`), and whether every browser can play it (H.264 → true; HEVC
   * plays in Safari only, so false: other browsers try and fall back to the download). Null for
   * photos and for videos not processed yet.
   */
  durationMs: z.number().int().nonnegative().nullable().default(null),
  videoCodec: z.string().nullable().default(null),
  playable: z.boolean().nullable().default(null),
  /** EXIF DateTimeOriginal (a video's `creation_time`), falling back to upload time (§8.2). */
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
   * The video itself (FR-VID-5, FR-VID-7), once `ready`: the original's stable CloudFront path for
   * own videos, a signed URL for shared ones (only where the preview is signed too: the viewer's
   * GET /photos/{id}). Null for photos. Missing (an API from before videos) reads as null.
   */
  videoUrl: z.string().nullable().default(null),
  /**
   * Set while the photo is in the trash (FR-DEL-3): when it was deleted and when the daily purge
   * removes it for good. Missing (an API from before the trash) reads as null.
   */
  trashedAt: isoDateTimeSchema.nullable().default(null),
  purgeAt: isoDateTimeSchema.nullable().default(null),
  /**
   * Whose photo it is: in a collaborative album (FR-SHR-11) photos of several people show
   * together. Missing (an API from before it) reads as null.
   */
  ownerId: userIdSchema.nullable().default(null),
  /** The owner's current username; set in album photo lists only (who added it), else null. */
  ownerUsername: z.string().nullable().default(null),
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

/**
 * DELETE /trash: emptying a big trash takes longer than one request may run (the API Lambda stops
 * at 10 s), so each request deletes for a few seconds and says how many are left; the client asks
 * again until `remaining` is 0.
 */
export const emptyTrashResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export type EmptyTrashResult = z.infer<typeof emptyTrashResultSchema>;

/** An original's file name as kept in metadata (trimmed, not empty). */
export const fileNameSchema = z.string().trim().min(1).max(MAX_FILE_NAME_LENGTH);

/** POST /photos/upload-url (FR-UP-2, FR-UP-3, NFR-SEC-6): photos only; videos: `/videos/uploads`. */
export const uploadUrlRequestSchema = z.object({
  fileName: fileNameSchema,
  contentType: photoContentTypeSchema,
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

/** POST /shared-albums/{albumId}/save: photos of that album to copy into my gallery (FR-SHR-10). */
export const saveSharedPhotosRequestSchema = z.object({
  photoIds: z.array(idSchema).min(1).max(MAX_PHOTOS_PER_SAVE_REQUEST),
});
export type SaveSharedPhotosRequest = z.infer<typeof saveSharedPhotosRequestSchema>;

/**
 * What happened to one photo: `saved` (a new copy, processing like an upload), `already-saved`
 * (my earlier copy, still there; `inTrash` if it is in my trash), `unavailable` (not in the album,
 * not processed, or gone) or `quota-exceeded` (doesn't fit in my storage).
 */
export const saveSharedPhotoResultSchema = z.enum([
  "saved",
  "already-saved",
  "unavailable",
  "quota-exceeded",
]);
export type SaveSharedPhotoResult = z.infer<typeof saveSharedPhotoResultSchema>;

export const saveSharedPhotosResponseSchema = z.object({
  /** One per requested photo, in request order. */
  items: z.array(
    z.object({
      photoId: idSchema,
      result: saveSharedPhotoResultSchema,
      /** My copy, for `saved` and `already-saved`. */
      savedPhotoId: idSchema.nullable(),
      inTrash: z.boolean(),
    }),
  ),
});
export type SaveSharedPhotosResponse = z.infer<typeof saveSharedPhotosResponseSchema>;
