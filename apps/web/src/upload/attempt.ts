import type { Api } from "@/api/api";
import { ApiRequestError, errorMessage } from "@/api/errors";
import {
  uploadVideo,
  VideoAlreadyUploadedError,
  VideoRejectedError,
  VideoRestartError,
  type VideoUploadState,
} from "./multipart";
import type { PutPart } from "./s3Part";
import { S3UploadError, type PostToS3 } from "./s3Post";
import type { UploadItem } from "./store";
import { isVideoType } from "./validate";

/** Backoff after a temporary failure: 2 s, 4 s, 8 s … capped at 1 min. */
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 60_000;
export const retryDelay = (attempts: number) =>
  Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

export interface AttemptDeps {
  api: Pick<Api, "photos"> & Partial<Pick<Api, "videos">>;
  post: PostToS3;
  now: () => number;
  /**
   * Videos (14.5): the part upload. Only the page's queue has videos (they're never stored, so
   * Background Sync never sees one); without it a video fails.
   */
  putPart?: PutPart;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AttemptOptions {
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** The first upload-url response: store the `photoId` before uploading (5.6a). */
  onPhotoId: (photoId: string) => Promise<void>;
  /** Videos: the upload's state changed (started, a part sent, completed), kept for a retry. */
  onVideoState?: (state: Partial<VideoUploadState>) => Promise<void> | void;
}

export interface AttemptResult {
  /** The photo is in S3: refresh what shows it before marking the item done. */
  uploaded: boolean;
  /** The item's new state. */
  patch: Partial<UploadItem>;
  /**
   * Failed in a way that says the connection or the backend is struggling (network, 5xx, 429,
   * stalled or expired upload): the queue sends fewer files at once (13.1i).
   */
  transient?: boolean;
}

class FileMissingError extends Error {
  constructor() {
    super("The file is no longer available on this device. Add it again.");
  }
}

export const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const DONE: Partial<UploadItem> = {
  status: "done",
  file: null,
  retryAt: 0,
  error: null,
  errorCode: null,
};

/**
 * One try at uploading a queue item (§12.4, FR-UP-4/5), for the page's queue and for Background
 * Sync in the service worker (9.5): request upload URL → POST straight to S3 → done. Every attempt
 * asks for a fresh signature (an old one has likely expired), passing the stored `photoId` after
 * the first, so a retry re-signs the same pending photo instead of creating a duplicate (5.6a).
 *
 * Temporary failures (network, 5xx, expired signature) come back queued with a backoff; permanent
 * ones (validation, quota) as failed, waiting for the user. Null: cancelled via `signal`.
 */
export async function attemptUpload(
  item: UploadItem,
  deps: AttemptDeps,
  options: AttemptOptions,
): Promise<AttemptResult | null> {
  if (isVideoType(item.contentType)) return attemptVideo(item, deps, options);
  return attemptPhoto(item, deps, options);
}

async function attemptPhoto(
  item: UploadItem,
  { api, post, now }: AttemptDeps,
  { signal, onProgress, onPhotoId }: AttemptOptions,
): Promise<AttemptResult | null> {
  let current = item;
  try {
    if (!current.file) throw new FileMissingError();
    // A large batch's file is read from the disk only now (13.1c): moved, renamed or deleted since
    // it was picked → a clear failure instead of endless network retries.
    if (current.memoryOnly) {
      try {
        await current.file.slice(0, 1).arrayBuffer();
      } catch {
        throw new FileMissingError();
      }
    }
    const contentType = current.contentType;
    if (isVideoType(contentType)) throw new Error("Not a photo");
    const { photoId, upload } = await api.photos.uploadUrl({
      fileName: current.fileName,
      contentType,
      sizeBytes: current.sizeBytes,
      // Finds the photo this item created even if its photoId never got stored here.
      uploadId: current.id,
      ...(current.photoId ? { photoId: current.photoId } : {}),
    });
    if (signal.aborted) return null;
    if (photoId !== current.photoId) {
      current = { ...current, photoId };
      await onPhotoId(photoId);
    }
    await post(upload, current.file!, { signal, ...(onProgress && { onProgress }) });
    if (signal.aborted) return null;
    return { uploaded: true, patch: DONE };
  } catch (error) {
    if (signal.aborted || isAbort(error)) return null;
    return failed(current, error, now);
  }
}

/**
 * A video (FR-VID-1–3, 14.5): a multipart upload (multipart.ts), resumed from the parts this tab
 * already sent. The same failure handling as photos, plus: the upload must start over
 * (`VideoRestartError`: state cleared, queued again at once), it was completed by an earlier try
 * (done), or `complete` refused the parts (the file changed: failed).
 */
async function attemptVideo(
  item: UploadItem,
  { api, now, putPart, sleep }: AttemptDeps,
  { signal, onProgress, onVideoState }: AttemptOptions,
): Promise<AttemptResult | null> {
  const contentType = item.contentType;
  try {
    if (!item.file) throw new FileMissingError();
    if (!api.videos || !putPart || !isVideoType(contentType)) {
      throw new Error("Videos can only be uploaded from the page that picked them.");
    }
    // Read from the disk only now, like a large batch (13.1c): gone since it was picked → a clear
    // failure instead of endless retries.
    try {
      await item.file.slice(0, 1).arrayBuffer();
    } catch {
      throw new FileMissingError();
    }
    await uploadVideo(
      { file: item.file, fileName: item.fileName, contentType, sizeBytes: item.sizeBytes },
      {
        photoId: item.photoId,
        videoUploadId: item.videoUploadId ?? null,
        videoParts: item.videoParts ?? null,
      },
      { api: { photos: api.photos, videos: api.videos }, putPart, now, ...(sleep && { sleep }) },
      {
        signal,
        ...(onProgress && { onProgress }),
        onState: (state) => onVideoState?.(state),
      },
    );
    if (signal.aborted) return null;
    return { uploaded: true, patch: { ...DONE, videoUploadId: null, videoParts: null } };
  } catch (error) {
    if (signal.aborted || isAbort(error)) return null;
    if (error instanceof VideoAlreadyUploadedError) {
      return { uploaded: true, patch: { ...DONE, videoUploadId: null, videoParts: null } };
    }
    if (error instanceof VideoRestartError) {
      // At once the first time; a restart that keeps happening backs off like other retries.
      const attempts = item.attempts + 1;
      return {
        uploaded: false,
        transient: true,
        patch: {
          status: "queued",
          photoId: null,
          videoUploadId: null,
          videoParts: null,
          attempts,
          retryAt: attempts > 1 ? now() + retryDelay(attempts) : 0,
        },
      };
    }
    if (error instanceof VideoRejectedError) {
      return {
        uploaded: false,
        patch: {
          status: "failed",
          error:
            "This video couldn't be uploaded. It may have changed since you picked it. Remove it and add it again.",
          errorCode: "S3_REJECTED",
        },
      };
    }
    return failed(item, error, now);
  }
}

function failed(item: UploadItem, error: unknown, now: () => number): AttemptResult {
  const result = (patch: Partial<UploadItem>) => ({ uploaded: false, patch });
  const later = (transient = true) => {
    const attempts = item.attempts + 1;
    return {
      ...result({ status: "queued", attempts, retryAt: now() + retryDelay(attempts) }),
      ...(transient && { transient }),
    };
  };

  if (error instanceof ApiRequestError) {
    // Re-signing a photo that is gone (deleted, or swept as abandoned by 6.11): start afresh.
    if (error.status === 404 && item.photoId) {
      return result({ status: "queued", photoId: null, retryAt: 0 });
    }
    // No longer pending: an earlier attempt reached S3 even though its answer got lost (the
    // photo found by photoId, or by uploadId when the photoId never got stored).
    if (error.status === 409) return { uploaded: true, patch: DONE };
    // The page's client already sent the user to /login; the upload continues after it.
    // An ended session says nothing about the connection (13.1i).
    if (error.code === "UNAUTHORIZED") return later(false);
    if (error.retryable) return later();
    return result({ status: "failed", error: errorMessage(error), errorCode: error.code });
  } else if (error instanceof S3UploadError) {
    if (error.retryable) return later();
    // The signed POST pins the exact size: an edited file is the usual cause.
    return result({
      status: "failed",
      error:
        "This file couldn't be uploaded. It may have changed since you picked it. Remove it and add it again.",
      errorCode: "S3_REJECTED",
    });
  } else if (error instanceof FileMissingError) {
    return result({ status: "failed", error: error.message, errorCode: "FILE_MISSING" });
  }
  return result({ status: "failed", error: errorMessage(error), errorCode: "UNKNOWN" });
}
