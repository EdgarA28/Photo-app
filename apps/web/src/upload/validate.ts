import {
  ALLOWED_CONTENT_TYPES,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  type AllowedContentType,
} from "@photo-app/shared";
import { formatBytes } from "@/lib/format";

/** File extensions accepted when the browser gives no (or a generic) type, e.g. HEIC on desktop. */
const EXTENSION_TYPES: Record<string, AllowedContentType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
};

/** `accept` for the file inputs: the types plus extensions, for browsers that don't know HEIC. */
export const ACCEPT = [
  ...ALLOWED_CONTENT_TYPES,
  ...Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`),
].join(",");

const isAllowed = (type: string): type is AllowedContentType =>
  (ALLOWED_CONTENT_TYPES as readonly string[]).includes(type);

/** The upload content type of a file (FR-UP-2): its own type if supported, else by extension. */
export function contentTypeOf(file: Pick<File, "name" | "type">): AllowedContentType | null {
  if (isAllowed(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? null;
}

/**
 * Why a picked file wasn't added (13.1b: the upload page groups them): not a supported photo
 * type, over 50 MB, empty, unreadable (e.g. a cloud file not on the device), or over a phone's
 * limit per pick (13.1c).
 */
export type SkipCode = "type" | "size" | "empty" | "unreadable" | "phoneLimit";

export type FileCheck =
  | { ok: true; contentType: AllowedContentType; fileName: string }
  | { ok: false; reason: string; code: SkipCode };

/**
 * Client-side check before a file enters the queue, mirroring the API's `uploadUrlRequestSchema`
 * (FR-UP-2, FR-UP-3), so a file that can never upload is rejected at once instead of failing later.
 */
export function checkFile(file: File): FileCheck {
  const contentType = contentTypeOf(file);
  if (!contentType) {
    return { ok: false, reason: "Not a supported type (JPEG, PNG, WebP or HEIC)", code: "type" };
  }
  if (file.size === 0) return { ok: false, reason: "The file is empty", code: "empty" };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `Larger than ${formatBytes(MAX_UPLOAD_BYTES)}`, code: "size" };
  }
  // Camera captures can come without a usable name; the API needs 1–255 characters.
  const fileName = file.name.trim().slice(0, MAX_FILE_NAME_LENGTH) || "photo";
  return { ok: true, contentType, fileName };
}
