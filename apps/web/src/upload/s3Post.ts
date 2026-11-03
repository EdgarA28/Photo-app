import type { UploadUrlResponse } from "@photo-app/shared";

/**
 * An upload with no progress for this long is given up and retried (13.1i): a dead connection
 * would otherwise keep a slot busy for good (XMLHttpRequest has no timeout by default). Counts
 * from the start and from every progress event, including the wait for S3's answer after the
 * last byte.
 */
export const STALL_TIMEOUT_MS = 45_000;

/** S3 rejected the POST or didn't answer (status 0). */
export class S3UploadError extends Error {
  override readonly name = "S3UploadError";

  constructor(readonly status: number) {
    super(status ? `S3 upload failed with HTTP ${status}` : "S3 upload failed: no response");
  }

  /**
   * Worth retrying with a fresh signature: no response, a server-side failure, or 403, which is
   * what an expired pre-signed POST (15 min, §9) returns. Other 4xx mean the request itself is
   * wrong (e.g. the file no longer matches the signed size) and will fail again.
   */
  get retryable(): boolean {
    return this.status === 0 || this.status === 403 || this.status >= 500;
  }
}

export interface PostOptions {
  /** Fraction sent, 0–1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** No progress for this long → `S3UploadError(0)` (default `STALL_TIMEOUT_MS`; 0 = never). */
  stallTimeoutMs?: number;
}

export type PostToS3 = (
  upload: UploadUrlResponse["upload"],
  file: Blob,
  options?: PostOptions,
) => Promise<void>;

/**
 * Sends the file straight to S3 with the pre-signed POST (FR-UP-4). XMLHttpRequest rather than
 * fetch: only XHR reports upload progress (FR-UP-6). The signed fields go first; S3 requires the
 * file to be the last field.
 */
export const postToS3: PostToS3 = (
  upload,
  file,
  { onProgress, signal, stallTimeoutMs = STALL_TIMEOUT_MS } = {},
) =>
  new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append("file", file);

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

    xhr.open("POST", upload.url);
    xhr.upload.onprogress = (event) => {
      watch();
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    // S3 answers 204 by default (no success_action_status in the signed fields).
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? done(undefined) : fail(new S3UploadError(xhr.status));
    xhr.onerror = xhr.ontimeout = () => fail(new S3UploadError(0));
    const cancelled = () => fail(new DOMException("Upload cancelled", "AbortError"));
    // Our own abort for a stall is a failure to retry, not a cancel.
    xhr.onabort = () => (stalled ? fail(new S3UploadError(0)) : cancelled());

    if (signal?.aborted) return cancelled();
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
    watch();
  });

/**
 * The same POST with fetch, for the service worker (9.5), which has no XMLHttpRequest. No
 * progress: fetch doesn't report upload progress.
 */
export const postToS3WithFetch =
  (doFetch: typeof fetch = fetch): PostToS3 =>
  async (upload, file, { signal } = {}) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append("file", file);
    let response: Response;
    try {
      response = await doFetch(upload.url, { method: "POST", body: form, signal: signal ?? null });
    } catch {
      if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
      throw new S3UploadError(0);
    }
    if (!response.ok) throw new S3UploadError(response.status);
  };
