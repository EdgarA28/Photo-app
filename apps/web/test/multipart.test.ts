/** Video multipart uploads (14.5, FR-VID-2): uploadVideo against a fake API and fake S3 parts. */
import { MULTIPART_PART_BYTES } from "@photo-app/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import {
  PARALLEL_PARTS,
  PART_TRIES,
  uploadVideo,
  URL_MARGIN_MS,
  VideoAlreadyUploadedError,
  VideoRejectedError,
  VideoRestartError,
  type VideoUploadDeps,
  type VideoUploadState,
} from "../src/upload/multipart";
import type { PutPart } from "../src/upload/s3Part";
import { S3UploadError } from "../src/upload/s3Post";

const PHOTO_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = Date.parse("2026-11-04T10:00:00.000Z");
/** Three parts: two full, the last 5 bytes. */
const SIZE = 2 * MULTIPART_PART_BYTES + 5;
const video = {
  file: new Blob([new Uint8Array(SIZE)], { type: "video/mp4" }),
  fileName: "clip.mp4",
  contentType: "video/mp4" as const,
  sizeBytes: SIZE,
};
const fresh: VideoUploadState = { photoId: null, videoUploadId: null, videoParts: null };

function setup() {
  let clock = NOW;
  const signed: number[][] = [];
  const api = {
    videos: {
      start: vi.fn(async () => ({
        photoId: PHOTO_ID,
        uploadId: "upload-1",
        partBytes: MULTIPART_PART_BYTES,
        partCount: 3,
      })),
      parts: vi.fn(async (_photoId: string, partNumbers: number[]) => {
        signed.push(partNumbers);
        return {
          parts: partNumbers.map((n) => ({ partNumber: n, url: `https://s3.test/part-${n}` })),
          expiresAt: new Date(clock + 15 * 60_000).toISOString(),
        };
      }),
      complete: vi.fn(async () => ({ photoId: PHOTO_ID })),
    },
    photos: { delete: vi.fn(async () => undefined) },
  };
  const sizes: Record<string, number> = {};
  let running = 0;
  let maxRunning = 0;
  const putPart = vi.fn<PutPart>(async (url, part, options) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    sizes[url] = part.size;
    options?.onProgress?.(part.size / 2);
    await Promise.resolve();
    running--;
    return `"etag-${url.split("-").pop()}"`;
  });
  const states: Partial<VideoUploadState>[] = [];
  const deps: VideoUploadDeps = {
    api: api as unknown as VideoUploadDeps["api"],
    putPart,
    now: () => clock,
    sleep: async () => {},
  };
  const options = {
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onState: (state: Partial<VideoUploadState>) => void states.push(state),
  };
  return {
    api,
    putPart,
    deps,
    options,
    states,
    signed,
    sizes,
    maxRunning: () => maxRunning,
    advance: (ms: number) => (clock += ms),
  };
}

const apiError = (status: number) => new ApiRequestError("CONFLICT", "nope", status);

describe("uploadVideo (FR-VID-2)", () => {
  it("starts the upload, sends every part with its exact size, then completes", async () => {
    const t = setup();
    await uploadVideo(video, fresh, t.deps, t.options);

    expect(t.api.videos.start).toHaveBeenCalledWith({
      fileName: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: SIZE,
    });
    expect(t.sizes).toEqual({
      "https://s3.test/part-1": MULTIPART_PART_BYTES,
      "https://s3.test/part-2": MULTIPART_PART_BYTES,
      "https://s3.test/part-3": 5,
    });
    // One signing request for all parts (≤ 100).
    expect(t.signed).toEqual([[1, 2, 3]]);
    expect(t.api.videos.complete).toHaveBeenCalledWith(PHOTO_ID, {
      parts: expect.arrayContaining([
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ]),
    });
    expect(t.states[0]).toEqual({ photoId: PHOTO_ID, videoUploadId: "upload-1", videoParts: [] });
    expect(t.states.at(-1)).toEqual({ videoUploadId: null });
    expect(t.options.onProgress).toHaveBeenLastCalledWith(1);
    expect(t.maxRunning()).toBeLessThanOrEqual(PARALLEL_PARTS);
  });

  it("resumes: only the parts not sent yet, progress from what was sent", async () => {
    const t = setup();
    const state: VideoUploadState = {
      photoId: PHOTO_ID,
      videoUploadId: "upload-1",
      videoParts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    };
    await uploadVideo(video, state, t.deps, t.options);

    expect(t.api.videos.start).not.toHaveBeenCalled();
    expect(Object.keys(t.sizes)).toEqual(["https://s3.test/part-3"]);
    expect(t.options.onProgress.mock.calls[0]![0]).toBeCloseTo((2 * MULTIPART_PART_BYTES) / SIZE);
    const [, body] = t.api.videos.complete.mock.calls[0] as unknown as [
      string,
      { parts: unknown[] },
    ];
    expect(body.parts).toHaveLength(3);
  });

  it("retries a part on its own after a dropped connection", async () => {
    const t = setup();
    let failed = false;
    const put = t.putPart.getMockImplementation()!;
    t.putPart.mockImplementation(async (url, part, options) => {
      if (url.endsWith("-2") && !failed) {
        failed = true;
        throw new S3UploadError(0);
      }
      return put(url, part, options);
    });
    await uploadVideo(video, fresh, t.deps, t.options);
    expect(t.putPart.mock.calls.filter(([url]) => url.endsWith("-2"))).toHaveLength(2);
    expect(t.api.videos.complete).toHaveBeenCalled();
  });

  it("signs a part again after 403 (expired URL)", async () => {
    const t = setup();
    let failed = false;
    const put = t.putPart.getMockImplementation()!;
    t.putPart.mockImplementation(async (url, part, options) => {
      if (url.endsWith("-1") && !failed) {
        failed = true;
        throw new S3UploadError(403);
      }
      return put(url, part, options);
    });
    await uploadVideo(video, fresh, t.deps, t.options);
    expect(t.signed.some((batch) => batch[0] === 1 && t.signed.indexOf(batch) > 0)).toBe(true);
  });

  it("signs again before sending once a URL nears its 15 minutes (this device's clock)", async () => {
    const t = setup();
    let failed = false;
    const put = t.putPart.getMockImplementation()!;
    t.putPart.mockImplementation(async (url, part, options) => {
      if (url.endsWith("-2") && !failed) {
        failed = true;
        // A long stall: by the retry, the URL has less than URL_MARGIN_MS left.
        t.advance(15 * 60_000 - URL_MARGIN_MS);
        throw new S3UploadError(0);
      }
      return put(url, part, options);
    });
    await uploadVideo(video, fresh, t.deps, t.options);
    expect(t.signed).toEqual([[1, 2, 3], [2]]);
  });

  it("gives up a part after PART_TRIES and fails the attempt (the queue backs off)", async () => {
    const t = setup();
    t.putPart.mockRejectedValue(new S3UploadError(503));
    await expect(uploadVideo(video, fresh, t.deps, t.options)).rejects.toBeInstanceOf(
      S3UploadError,
    );
    const tries = t.putPart.mock.calls.filter(([url]) => url.endsWith("-1")).length;
    expect(tries).toBeLessThanOrEqual(PART_TRIES);
    expect(t.api.videos.complete).not.toHaveBeenCalled();
  });

  it("a part S3 refuses for good (the file changed) fails at once", async () => {
    const t = setup();
    t.putPart.mockRejectedValue(new S3UploadError(400));
    await expect(uploadVideo(video, fresh, t.deps, t.options)).rejects.toMatchObject({
      status: 400,
    });
    expect(t.putPart.mock.calls.length).toBeLessThanOrEqual(PARALLEL_PARTS);
  });

  it("the pending video is gone (404) → start over", async () => {
    const t = setup();
    t.api.videos.parts.mockRejectedValue(apiError(404));
    await expect(uploadVideo(video, fresh, t.deps, t.options)).rejects.toBeInstanceOf(
      VideoRestartError,
    );
  });

  it("parts of a completed upload (409) → already uploaded", async () => {
    const t = setup();
    t.api.videos.parts.mockRejectedValue(apiError(409));
    await expect(uploadVideo(video, fresh, t.deps, t.options)).rejects.toBeInstanceOf(
      VideoAlreadyUploadedError,
    );
  });

  it("complete finds the upload aborted (409): the pending video is deleted, start over", async () => {
    const t = setup();
    t.api.videos.complete.mockRejectedValue(apiError(409));
    await expect(uploadVideo(video, fresh, t.deps, t.options)).rejects.toBeInstanceOf(
      VideoRestartError,
    );
    expect(t.api.photos.delete).toHaveBeenCalledWith(PHOTO_ID);
  });

  it("complete refuses the parts (400) → rejected", async () => {
    const t = setup();
    t.api.videos.complete.mockRejectedValue(apiError(400));
    await expect(uploadVideo(video, fresh, t.deps, t.options)).rejects.toBeInstanceOf(
      VideoRejectedError,
    );
  });

  it("quota and other API errors of the start come through as they are", async () => {
    const t = setup();
    const quota = new ApiRequestError("QUOTA_EXCEEDED", "full", 413);
    t.api.videos.start.mockRejectedValue(quota);
    await expect(uploadVideo(video, fresh, t.deps, t.options)).rejects.toBe(quota);
  });

  it("cancelled: the running parts stop, nothing is completed", async () => {
    const t = setup();
    const controller = new AbortController();
    t.putPart.mockImplementation(
      (_url, _part, options) =>
        new Promise((_, reject) => {
          const cancelled = () => reject(new DOMException("Upload cancelled", "AbortError"));
          if (options?.signal?.aborted) return cancelled();
          options?.signal?.addEventListener("abort", cancelled);
          controller.abort();
        }),
    );
    await expect(
      uploadVideo(video, fresh, t.deps, { ...t.options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(t.api.videos.complete).not.toHaveBeenCalled();
  });
});
