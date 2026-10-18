/**
 * S3 key layout for the photo bucket (§8.1). This is the single source of truth;
 * services/thumbnails mirrors it and both are tested against test-vectors/s3-keys.json.
 *
 *   users/{userId}/originals/{photoId}.{ext}
 *   users/{userId}/thumbs/{photoId}.jpg
 *   users/{userId}/previews/{photoId}.jpg
 */
import {
  CONTENT_TYPE_EXTENSIONS,
  ORIGINAL_EXTENSIONS,
  type AllowedContentType,
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

export function extensionFor(contentType: AllowedContentType): OriginalExtension {
  return CONTENT_TYPE_EXTENSIONS[contentType];
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

export interface ParsedOriginalKey {
  userId: string;
  photoId: string;
  ext: OriginalExtension;
}

/** Returns null for anything that is not a well-formed original key (loop protection, §10). */
export function parseOriginalKey(key: string): ParsedOriginalKey | null {
  const match = ORIGINAL_KEY_REGEX.exec(key);
  if (!match) return null;
  const [, userId, photoId, ext] = match as unknown as [string, string, string, OriginalExtension];
  if (!isUserId(userId) || !isId(photoId)) return null;
  return { userId, photoId, ext };
}
