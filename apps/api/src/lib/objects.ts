import { playbackKey, previewKey, thumbKey } from "@photo-app/shared";
import type { PhotoRecord } from "../repo";
import type { PhotoStorage } from "./storage";

/**
 * Every S3 object a photo or video may have (§8.1): the original, thumb and preview (a video's
 * poster frame), and a video's playback copy (B-7 V2; deleting a key that doesn't exist is fine).
 */
export function objectKeys(
  record: Pick<PhotoRecord, "userId" | "photoId" | "originalKey" | "mediaType">,
): string[] {
  const { userId, photoId } = record;
  return [
    record.originalKey,
    thumbKey(userId, photoId),
    previewKey(userId, photoId),
    ...(record.mediaType === "video" ? [playbackKey(userId, photoId)] : []),
  ];
}

/**
 * The file a video plays from (FR-VID-5, 14.9): its playback copy once the video service made it,
 * the original otherwise (copy pending, failed or skipped, or a video from before 14.9).
 */
export function videoKey(
  record: Pick<PhotoRecord, "userId" | "photoId" | "originalKey" | "playbackStatus">,
): string {
  return record.playbackStatus === "ready"
    ? playbackKey(record.userId, record.photoId)
    : record.originalKey;
}

/**
 * Stops a video upload still in progress (FR-VID-2), before the photo is deleted: its parts go,
 * and no part URL handed out earlier can add to it. Photos and finished uploads have none.
 */
export async function abortUpload(storage: PhotoStorage, record: PhotoRecord): Promise<void> {
  if (record.uploadId) {
    await storage.abortMultipartUpload({ key: record.originalKey, uploadId: record.uploadId });
  }
}
