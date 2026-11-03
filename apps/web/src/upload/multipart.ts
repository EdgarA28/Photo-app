import {
  MAX_PARTS_PER_SIGN_REQUEST,
  MULTIPART_PART_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  videoPartCount,
  type VideoContentType,
} from "@photo-app/shared";
import type { Api } from "@/api/api";
import { ApiRequestError } from "@/api/errors";
import type { PutPart } from "./s3Part";
import { S3UploadError } from "./s3Post";

/** Parts sent at once (FR-VID-2, §12.4): 3 × 16 MB in flight per video. */
export const PARALLEL_PARTS = 3;
/** Tries per part within one attempt before the attempt fails (the queue then backs off). */
export const PART_TRIES = 4;
/** Pause before a part's next try: 1 s, 2 s, 4 s. */
export const partRetryDelay = (failures: number) => 1000 * 2 ** (failures - 1);
/**
 * A part URL is used until this long before its 15 min are up (counted on this device's clock from
 * when it arrived, so a device clock that is off doesn't matter), then signed again.
 */
export const URL_MARGIN_MS = 60_000;
const URL_USABLE_MS = UPLOAD_URL_TTL_SECONDS * 1000 - URL_MARGIN_MS;

/** A part uploaded in this or an earlier attempt, with the ETag `complete` needs. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** What a video upload keeps between attempts (in the item, in this tab's memory). */
export interface VideoUploadState {
  photoId: string | null;
  /** S3's multipart upload ID while the upload runs; null before it started and once completed. */
  videoUploadId: string | null;
  videoParts: UploadedPart[] | null;
}

export interface VideoUploadDeps {
  api: Pick<Api, "videos" | "photos">;
  putPart: PutPart;
  now: () => number;
  /** Waits (cancelled by `signal`); a timer in the app. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface VideoUploadOptions {
  signal: AbortSignal;
  /** Fraction sent, 0–1, counting finished parts and the bytes of the ones in flight. */
  onProgress?: (fraction: number) => void;
  /** The state changed (started, a part finished, completed): keep it for the next attempt. */
  onState: (state: Partial<VideoUploadState>) => Promise<void> | void;
}

export interface VideoFile {
  file: Blob;
  fileName: string;
  contentType: VideoContentType;
  sizeBytes: number;
}

/**
 * The upload can't go on as it is and must start over: the pending video is gone (deleted, or
 * swept as abandoned, 6.11) or its multipart upload was aborted or expired (that pending video is
 * deleted first). The queue clears the state and tries again from the first part.
 */
export class VideoRestartError extends Error {
  override readonly name = "VideoRestartError";
}

/** `complete` was refused: the parts don't add up to the file picked (it changed meanwhile). */
export class VideoRejectedError extends Error {
  override readonly name = "VideoRejectedError";
}

/** The video is already uploaded (an earlier attempt completed it; its answer got lost). */
export class VideoAlreadyUploadedError extends Error {
  override readonly name = "VideoAlreadyUploadedError";
}

const abortError = () => new DOMException("Upload cancelled", "AbortError");

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });

/**
 * Uploads a video as an S3 multipart upload (FR-VID-1–3, §9, 14.5): `POST /videos/uploads` (quota,
 * pending item), part URLs from `/videos/{id}/parts` (up to 100 at a time, signed again when they
 * near their 15 min), each part PUT straight to S3, `PARALLEL_PARTS` at once, each retried on its
 * own, then `/videos/{id}/complete`.
 *
 * Resumable within the tab: `state` carries the pending video and the parts already sent from an
 * earlier attempt (after a dropped connection or a pause), so only the missing parts go again. A
 * reload starts over (videos are kept in the picking tab only, 13.1c).
 *
 * Throws `ApiRequestError` / `S3UploadError` (the queue's usual handling), `VideoRestartError`,
 * `VideoRejectedError`, `VideoAlreadyUploadedError`, or an AbortError when `signal` fires.
 */
export async function uploadVideo(
  video: VideoFile,
  state: VideoUploadState,
  { api, putPart, now, sleep = defaultSleep }: VideoUploadDeps,
  { signal, onProgress, onState }: VideoUploadOptions,
): Promise<void> {
  let { photoId, videoUploadId } = state;
  const done = new Map((state.videoParts ?? []).map((p) => [p.partNumber, p.etag]));

  if (!photoId || !videoUploadId) {
    // A pending video from an attempt that never got its upload going: start a fresh one.
    if (photoId) await api.photos.delete(photoId).catch(() => {});
    const started = await api.videos.start({
      fileName: video.fileName,
      contentType: video.contentType,
      sizeBytes: video.sizeBytes,
    });
    if (signal.aborted) throw abortError();
    photoId = started.photoId;
    videoUploadId = started.uploadId;
    done.clear();
    await onState({ photoId, videoUploadId, videoParts: [] });
  }

  const partCount = videoPartCount(video.sizeBytes);
  const sizeOf = (n: number) =>
    Math.min(MULTIPART_PART_BYTES, video.sizeBytes - (n - 1) * MULTIPART_PART_BYTES);
  const todo: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!done.has(n)) todo.push(n);

  // Progress: finished parts plus what the running ones have sent.
  let doneBytes = 0;
  for (const n of done.keys()) doneBytes += sizeOf(n);
  const inFlight = new Map<number, number>();
  const report = () => {
    let sent = doneBytes;
    for (const bytes of inFlight.values()) sent += bytes;
    onProgress?.(Math.min(sent / video.sizeBytes, 1));
  };
  report();

  // Part URLs, signed in batches; one signing request at a time.
  const urls = new Map<number, { url: string; usableUntil: number }>();
  let signing: Promise<void> | undefined;
  const pending = new Set(todo);
  async function sign(n: number) {
    const batch = [n, ...[...pending].filter((p) => p !== n && !urls.has(p))].slice(
      0,
      MAX_PARTS_PER_SIGN_REQUEST,
    );
    const { parts } = await callApi(() =>
      api.videos.parts(photoId!, batch, { signal: inner.signal }),
    );
    const usableUntil = now() + URL_USABLE_MS;
    for (const part of parts) urls.set(part.partNumber, { url: part.url, usableUntil });
  }
  async function urlFor(n: number): Promise<string> {
    const known = urls.get(n);
    if (known && known.usableUntil > now()) return known.url;
    urls.delete(n);
    // A batch being signed may include this part; else sign one with it.
    if (signing) await signing;
    if (!urls.has(n)) {
      signing = sign(n).finally(() => (signing = undefined));
      await signing;
    }
    const fresh = urls.get(n);
    if (!fresh) throw new Error(`No URL for part ${n}`);
    return fresh.url;
  }

  /** 404: the pending video is gone; 409 on parts: it is uploaded already. */
  async function callApi<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        throw new VideoRestartError("The video's upload is gone");
      }
      if (error instanceof ApiRequestError && error.status === 409) {
        throw new VideoAlreadyUploadedError("Already uploaded");
      }
      throw error;
    }
  }

  // The first part that fails for good stops the others.
  const inner = new AbortController();
  const stop = () => inner.abort();
  signal.addEventListener("abort", stop, { once: true });

  async function sendPart(n: number) {
    const start = (n - 1) * MULTIPART_PART_BYTES;
    const blob = video.file.slice(start, start + sizeOf(n));
    for (let failures = 0; ;) {
      try {
        const url = await urlFor(n);
        const etag = await putPart(url, blob, {
          signal: inner.signal,
          onProgress: (loaded) => {
            inFlight.set(n, loaded);
            report();
          },
        });
        inFlight.delete(n);
        done.set(n, etag);
        doneBytes += sizeOf(n);
        report();
        await onState({
          videoParts: [...done].map(([partNumber, e]) => ({ partNumber, etag: e })),
        });
        return;
      } catch (error) {
        inFlight.delete(n);
        report();
        if (inner.signal.aborted || !(error instanceof S3UploadError) || !error.retryable) {
          throw error;
        }
        // 403: the URL most likely expired (a long pause, a slow link): sign it again.
        if (error.status === 403) urls.delete(n);
        failures++;
        if (failures >= PART_TRIES) throw error;
        await sleep(partRetryDelay(failures), inner.signal);
      }
    }
  }

  try {
    const queue = [...todo];
    let failure: unknown;
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        // Stopped (cancel, or another part failed for good): start no more parts.
        if (inner.signal.aborted) return;
        pending.delete(n);
        try {
          await sendPart(n);
        } catch (error) {
          failure ??= error;
          inner.abort();
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_PARTS, todo.length) }, () => worker()),
    );
    if (signal.aborted) throw abortError();
    if (failure !== undefined) throw failure;
  } finally {
    signal.removeEventListener("abort", stop);
  }

  try {
    await api.videos.complete(photoId, {
      parts: [...done].map(([partNumber, etag]) => ({ partNumber, etag })),
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      // Gone, or its multipart upload aborted / expired: start over. A pending video whose upload
      // expired would hold its quota reservation until the daily sweep: deleted now.
      if (error.status === 409) await api.photos.delete(photoId).catch(() => {});
      if (error.status === 404 || error.status === 409) {
        throw new VideoRestartError("The video's upload is gone");
      }
      if (error.status === 400) throw new VideoRejectedError(error.message);
    }
    throw error;
  }
  await onState({ videoUploadId: null });
}
