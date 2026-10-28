/** Supported upload content types and the file extension used for the original in S3 (FR-UP-2). */
export const CONTENT_TYPE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
} as const;

export type AllowedContentType = keyof typeof CONTENT_TYPE_EXTENSIONS;
export type OriginalExtension = (typeof CONTENT_TYPE_EXTENSIONS)[AllowedContentType];

export const ALLOWED_CONTENT_TYPES = Object.keys(CONTENT_TYPE_EXTENSIONS) as [
  AllowedContentType,
  ...AllowedContentType[],
];

export const ORIGINAL_EXTENSIONS = [...new Set(Object.values(CONTENT_TYPE_EXTENSIONS))] as [
  OriginalExtension,
  ...OriginalExtension[],
];

/** Max size of a single uploaded photo (FR-UP-3). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Max length of an original file name kept in metadata. */
export const MAX_FILE_NAME_LENGTH = 255;

/** Pagination (§9). */
export const PAGE_LIMIT_DEFAULT = 60;
export const PAGE_LIMIT_MAX = 200;

/** Album limits. */
export const MAX_ALBUM_NAME_LENGTH = 100;
export const MAX_PHOTOS_PER_ALBUM_REQUEST = 100;

/** Usernames (FR-ACC-3). */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
/** How long a released username stays held for its former owner (D-8). */
export const USERNAME_HOLD_DAYS = 30;
/** Names nobody can claim: they could pass for the app or its staff. */
export const RESERVED_USERNAMES: readonly string[] = [
  "admin",
  "administrator",
  "anonymous",
  "api",
  "help",
  "mail",
  "me",
  "null",
  "photo.app",
  "photo_app",
  "photoapp",
  "root",
  "security",
  "support",
  "system",
  "undefined",
  "www",
];

/** Days a deleted photo stays in the trash before the daily purge removes it for good (FR-DEL-3). */
export const TRASH_RETENTION_DAYS = 15;

/** URL / cookie lifetimes in seconds (§9). */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
export const SHARED_IMAGE_URL_TTL_SECONDS = 15 * 60;
export const MEDIA_COOKIE_TTL_SECONDS = 8 * 60 * 60;

/** Derived image sizes (§10). */
export const THUMB_MAX_EDGE = 400;
export const PREVIEW_MAX_EDGE = 1600;
