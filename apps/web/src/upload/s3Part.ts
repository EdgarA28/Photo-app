import { S3UploadError, STALL_TIMEOUT_MS } from "./s3Post";

export interface PutPartOptions {
  /** Bytes of this part sent so far. */
  onProgress?: (loaded: number) => void;
  signal?: AbortSignal;
  /** No progress for this long → `S3UploadError(0)` (default `STALL_TIMEOUT_MS`; 0 = never). */
  stallTimeoutMs?: number;
}

/** Uploads one part to its pre-signed URL; resolves with the part's ETag (for `complete`). */
export type PutPart = (url: string, part: Blob, options?: PutPartOptions) => Promise<string>;

/**
 * One part of a video's multipart upload (FR-VID-2, 14.5): a PUT of the bytes to the pre-signed
 * `UploadPart` URL. XMLHttpRequest for upload progress, like photos (s3Post.ts). The URL is signed
 * with the part's exact Content-Length, which the browser sets from the Blob. S3 returns the
 * part's ETag in a header the bucket's CORS exposes (14.4).
 *
 * Errors are `S3UploadError`s: 403 is usually an expired URL (sign again), 0 a dropped
 * connection or a stall, 5xx S3 trouble; other 4xx mean the part can't succeed (e.g. the file
 * changed size since it was picked).
 */
export const putPart: PutPart = (
  url,
  part,
  { onProgress, signal, stallTimeoutMs = STALL_TIMEOUT_MS } = {},
) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const watch = () => {
      clearTimeout(stall);
      if (stallTimeoutMs > 0) {
        stall = setTimeout(() => {
          stalled = true;
          xhr.abort();
        }, stallTimeoutMs);
      }
    };
    const settle =
      <T>(outcome: (value: T) => void) =>
      (value: T) => {
        clearTimeout(stall);
        outcome(value);
      };
    const done = settle(resolve);
    const fail = settle(reject);

    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => {
      watch();
      onProgress?.(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return fail(new S3UploadError(xhr.status));
      const etag = xhr.getResponseHeader("ETag");
      // Without it the part can't be completed: CORS not exposing ETag, or a proxy dropping it.
      if (!etag) return fail(new S3UploadError(xhr.status));
      done(etag);
    };
    xhr.onerror = xhr.ontimeout = () => fail(new S3UploadError(0));
    const cancelled = () => fail(new DOMException("Upload cancelled", "AbortError"));
    xhr.onabort = () => (stalled ? fail(new S3UploadError(0)) : cancelled());

    if (signal?.aborted) return cancelled();
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(part);
    watch();
  });
