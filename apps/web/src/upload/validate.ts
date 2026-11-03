import {
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
  MEDIA_CONTENT_TYPES,
  VIDEO_CONTENT_TYPES,
  type MediaContentType,
  type MediaType,
  type VideoContentType,
} from "@photo-app/shared";
import { formatBytes } from "@/lib/format";

/**
 * File extensions accepted when the browser gives no (or a generic) type, e.g. HEIC on desktop.
 * MP4 and MOV videos since 14.5 (FR-VID-1).
 */
const EXTENSION_TYPES: Record<string, MediaContentType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/** `accept` for the file inputs: the types plus extensions, for browsers that don't know HEIC. */
export const ACCEPT = [
  ...MEDIA_CONTENT_TYPES,
  ...Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`),
].join(",");

const isAllowed = (type: string): type is MediaContentType =>
  (MEDIA_CONTENT_TYPES as readonly string[]).includes(type);

export const isVideoType = (type: string): type is VideoContentType =>
  (VIDEO_CONTENT_TYPES as readonly string[]).includes(type);

export const mediaTypeOf = (contentType: string): MediaType =>
  isVideoType(contentType) ? "video" : "photo";

/** Largest file of each kind (FR-UP-3, FR-VID-1). */
export const maxBytesFor = (contentType: MediaContentType) =>
  isVideoType(contentType) ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES;

/**
 * The upload content type of a file (FR-UP-2, FR-VID-1): its own type if supported, else by
 * extension (e.g. a `.mov` some browsers report as empty or `application/octet-stream`).
 */
export function contentTypeOf(file: Pick<File, "name" | "type">): MediaContentType | null {
  if (isAllowed(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? null;
}

/**
 * Why a picked file wasn't added (13.1b: the upload page groups them): not a supported photo or
 * video type, over its size limit (50 MB photo, 2 GB video), empty, unreadable (e.g. a cloud file
 * not on the device), or over a phone's limit per pick (13.1c).
 */
export type SkipCode = "type" | "size" | "videoSize" | "empty" | "unreadable" | "phoneLimit";

export type FileCheck =
  | { ok: true; contentType: MediaContentType; fileName: string }
  | { ok: false; reason: string; code: SkipCode };

/**
 * Client-side check before a file enters the queue, mirroring the API's `uploadUrlRequestSchema`
 * and `startVideoUploadRequestSchema` (FR-UP-2/3, FR-VID-1), so a file that can never upload is
 * rejected at once instead of failing later.
 */
export function checkFile(file: File): FileCheck {
  const contentType = contentTypeOf(file);
  if (!contentType) {
    return {
      ok: false,
      reason: "Not a supported type (JPEG, PNG, WebP, HEIC, MP4 or MOV)",
      code: "type",
    };
  }
  if (file.size === 0) return { ok: false, reason: "The file is empty", code: "empty" };
  const max = maxBytesFor(contentType);
  if (file.size > max) {
    return {
      ok: false,
      reason: `Larger than ${formatBytes(max)}`,
      code: isVideoType(contentType) ? "videoSize" : "size",
    };
  }
  // Camera captures can come without a usable name; the API needs 1–255 characters.
  const fallback = isVideoType(contentType) ? "video" : "photo";
  const fileName = file.name.trim().slice(0, MAX_FILE_NAME_LENGTH) || fallback;
  return { ok: true, contentType, fileName };
}
