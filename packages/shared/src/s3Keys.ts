/**
 * S3 key layout for the photo bucket (§8.1). This is the single source of truth;
 * services/thumbnails mirrors it and both are tested against test-vectors/s3-keys.json.
 *
 *   users/{userId}/originals/{photoId}.{ext}   photo or video (FR-VID-1: mp4, mov)
 *   users/{userId}/thumbs/{photoId}.jpg        a video's poster frame too (§10.2)
 *   users/{userId}/previews/{photoId}.jpg
 *   users/{userId}/playback/{photoId}.mp4      a video's playback copy (14.9, video Lambda)
 */
import {
  CONTENT_TYPE_EXTENSIONS,
  ORIGINAL_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type MediaContentType,
  type MediaType,
  type OriginalExtension,
} from "./constants";
import { isId, isUserId } from "./ids";

const ORIGINAL_KEY_REGEX = new RegExp(
  `^users/([^/]+)/originals/([^/.]+)\\.(${ORIGINAL_EXTENSIONS.join("|")})$`,
);

function assertIds(userId: string, photoId: string): void {
  if (!isUserId(userId)) throw new Error(`Invalid userId: ${userId}`);
  if (!isId(photoId)) throw new Error(`Invalid photoId: ${photoId}`);
}

/** Prefix of everything a user owns; also the path covered by their media cookie. */
export function userPrefix(userId: string): string {
  if (!isUserId(userId)) throw new Error(`Invalid userId: ${userId}`);
  return `users/${userId}/`;
}

export function extensionFor(contentType: MediaContentType): OriginalExtension {
  return CONTENT_TYPE_EXTENSIONS[contentType];
}

/** Photo or video, by the original's extension. */
export function mediaTypeOfExtension(ext: OriginalExtension): MediaType {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext) ? "video" : "photo";
}

export function originalKey(userId: string, photoId: string, ext: OriginalExtension): string {
  assertIds(userId, photoId);
  return `users/${userId}/originals/${photoId}.${ext}`;
}

export function thumbKey(userId: string, photoId: string): string {
  assertIds(userId, photoId);
  return `users/${userId}/thumbs/${photoId}.jpg`;
}

export function previewKey(userId: string, photoId: string): string {
  assertIds(userId, photoId);
  return `users/${userId}/previews/${photoId}.jpg`;
}

/** The playback copy of a video (14.9): 720p H.264/AAC MP4, written by the video service. */
export function playbackKey(userId: string, photoId: string): string {
  assertIds(userId, photoId);
  return `users/${userId}/playback/${photoId}.mp4`;
}

export interface ParsedOriginalKey {
  userId: string;
  photoId: string;
  ext: OriginalExtension;
  /** Which handler processes it: photos the thumbnail service, videos the video service (§10.2). */
  mediaType: MediaType;
}

/** Returns null for anything that is not a well-formed original key (loop protection, §10). */
export function parseOriginalKey(key: string): ParsedOriginalKey | null {
  const match = ORIGINAL_KEY_REGEX.exec(key);
  if (!match) return null;
  const [, userId, photoId, ext] = match as unknown as [string, string, string, OriginalExtension];
  if (!isUserId(userId) || !isId(photoId)) return null;
  return { userId, photoId, ext, mediaType: mediaTypeOfExtension(ext) };
}
