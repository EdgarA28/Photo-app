/** Supported photo content types and the file extension of the original in S3 (FR-UP-2). */
export const PHOTO_CONTENT_TYPE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
} as const;

/** Supported video content types and the file extension of the original in S3 (FR-VID-1). */
export const VIDEO_CONTENT_TYPE_EXTENSIONS = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
} as const;

/** Every original: photos and videos share the Photo item and the `originals/` prefix (§8.1). */
export const CONTENT_TYPE_EXTENSIONS = {
  ...PHOTO_CONTENT_TYPE_EXTENSIONS,
  ...VIDEO_CONTENT_TYPE_EXTENSIONS,
} as const;

export type PhotoContentType = keyof typeof PHOTO_CONTENT_TYPE_EXTENSIONS;
export type VideoContentType = keyof typeof VIDEO_CONTENT_TYPE_EXTENSIONS;
export type MediaContentType = PhotoContentType | VideoContentType;

export type PhotoExtension = (typeof PHOTO_CONTENT_TYPE_EXTENSIONS)[PhotoContentType];
export type VideoExtension = (typeof VIDEO_CONTENT_TYPE_EXTENSIONS)[VideoContentType];
export type OriginalExtension = PhotoExtension | VideoExtension;

/** What a Photo item holds (§8.2, FR-VID-*); a missing `mediaType` is a photo. */
export const MEDIA_TYPES = ["photo", "video"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** Photo upload types (`POST /photos/upload-url`, share target, Google Photos import). */
export const PHOTO_CONTENT_TYPES = Object.keys(PHOTO_CONTENT_TYPE_EXTENSIONS) as [
  PhotoContentType,
  ...PhotoContentType[],
];
/** Video upload types (`POST /videos/uploads`, FR-VID-1). */
export const VIDEO_CONTENT_TYPES = Object.keys(VIDEO_CONTENT_TYPE_EXTENSIONS) as [
  VideoContentType,
  ...VideoContentType[],
];
/** Any original's type, as stored on the item and returned by the API. */
export const MEDIA_CONTENT_TYPES = [...PHOTO_CONTENT_TYPES, ...VIDEO_CONTENT_TYPES] as [
  MediaContentType,
  ...MediaContentType[],
];

export const PHOTO_EXTENSIONS = [...new Set(Object.values(PHOTO_CONTENT_TYPE_EXTENSIONS))] as [
  PhotoExtension,
  ...PhotoExtension[],
];
export const VIDEO_EXTENSIONS = [...new Set(Object.values(VIDEO_CONTENT_TYPE_EXTENSIONS))] as [
  VideoExtension,
  ...VideoExtension[],
];
export const ORIGINAL_EXTENSIONS = [...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS] as [
  OriginalExtension,
  ...OriginalExtension[],
];

/** Max size of a single uploaded photo (FR-UP-3). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Max size of a single video (FR-VID-1, 14.0): 2 GB. Below S3's 5 GB limit for one CopyObject,
 * which saving a shared video to one's gallery relies on (FR-SHR-10).
 */
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Part size of a video's multipart upload (FR-VID-2): 16 MB, so 2 GB is 128 parts (S3 allows
 * 10,000, each part except the last at least 5 MB). Small enough that a dropped connection
 * repeats little.
 */
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;

/**
 * Longest video that gets a playback copy (14.9, spec §10.2): the copy is made in one Lambda
 * invocation (15 min at most). Longer ones play their original. Mirrored in
 * services/thumbnails `video_processor.py`.
 */
export const MAX_PLAYBACK_DURATION_MS = 20 * 60 * 1000;

/** Most parts a video can have: `MAX_VIDEO_BYTES / MULTIPART_PART_BYTES`. */
export const MAX_VIDEO_PARTS = Math.ceil(MAX_VIDEO_BYTES / MULTIPART_PART_BYTES);

/** Part URLs signed per `POST /videos/{photoId}/parts` request (§9). */
export const MAX_PARTS_PER_SIGN_REQUEST = 100;

/**
 * Biggest video accepted through the share target (FR-VID-9): the service worker keeps shared
 * files in IndexedDB until the app picks them up.
 */
export const MAX_SHARED_VIDEO_BYTES = 200 * 1024 * 1024;

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

/** How long a public photo link works, and how many photos one link can hold (FR-SHR-8). */
export const PHOTO_LINK_TTL_SECONDS = 15 * 60;
export const MAX_PHOTOS_PER_LINK = 100;

/**
 * Photos of a shared album saved to one's own gallery per request (FR-SHR-10): each is a server-side
 * copy, and the API has 10 s, so the web app sends a bigger selection in batches of this size.
 */
export const MAX_PHOTOS_PER_SAVE_REQUEST = 10;

/** URL / cookie lifetimes in seconds (§9). */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
export const SHARED_IMAGE_URL_TTL_SECONDS = 15 * 60;
/**
 * A shared video's signed URL (FR-VID-7): the player sends range requests for as long as it plays,
 * so 15 minutes would cut off a longer video. Recipients may download it anyway.
 */
export const SHARED_VIDEO_URL_TTL_SECONDS = 4 * 60 * 60;
export const MEDIA_COOKIE_TTL_SECONDS = 8 * 60 * 60;

/** Derived image sizes (§10); a video's poster frame uses the same two (§10.2). */
export const THUMB_MAX_EDGE = 400;
export const PREVIEW_MAX_EDGE = 1600;

/**
 * Similar photos (8.37, FR-GAL-10/11/12): the thumbnail Lambda's difference hash of a ready photo,
 * 64 bits as 16 lowercase hex characters (§8.2, §10; `services/thumbnails/.../similarity.py`).
 */
export const SIMILARITY_HASH_REGEX = /^[0-9a-f]{16}$/;

/**
 * Duplicates (8.37f, FR-GAL-12, §9): near-identical images are at most this many bits apart
 * (re-encoded or resized copies are 0–2 on the user's dev photos and in the Lambda's tests).
 */
export const DUPLICATE_MAX_BITS = 3;
/** A duplicate group's key: hex of the SHA-256 of its sorted photo IDs, first 128 bits (§8.2). */
export const DUPLICATE_KEY_REGEX = /^[0-9a-f]{32}$/;
/** Photos in one dismiss request: a group is rarely more than a few copies. */
export const MAX_PHOTOS_PER_DUPLICATE_GROUP = 100;

// Import from Google Photos (13.5, §6.9, §10.1, §11.5)
/** Most photos one import copies (FR-IMP-2). */
export const MAX_PHOTOS_PER_IMPORT = 500;
/** An Import item is removed by DynamoDB TTL this long after it was created (§8.2). */
export const IMPORT_TTL_DAYS = 7;
/** The only Google scope the import asks for (FR-IMP-2, NFR-SEC-10). */
export const GOOGLE_PHOTOS_PICKER_SCOPE =
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
/** App route Google redirects back to after the import consent (§11.5, §12.1). */
export const GOOGLE_IMPORT_CALLBACK_PATH = "/import/google/callback";
