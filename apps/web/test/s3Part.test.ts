/** One part of a video's multipart upload (14.5): PUT to the pre-signed URL, ETag back. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { putPart } from "../src/upload/s3Part";
import { S3UploadError, STALL_TIMEOUT_MS } from "../src/upload/s3Post";

class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  body: Blob | undefined;
  status = 0;
  headers: Record<string, string> = {};
  upload: { onprogress?: (event: Partial<ProgressEvent>) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: Blob) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  getResponseHeader(name: string) {
    return this.headers[name] ?? null;
  }
  respond(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = headers;
    this.onload?.();
  }
}

const URL_ = "https://photos.s3.amazonaws.com/users/u/originals/v.mp4?partNumber=1&uploadId=x";
const part = new Blob(["abcd"]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("putPart (FR-VID-2)", () => {
  it("PUTs the bytes, reports progress and resolves with the ETag", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const onProgress = vi.fn();
    const sent = putPart(URL_, part, { onProgress });
    const xhr = FakeXhr.last;
    expect([xhr.method, xhr.url, xhr.body]).toEqual(["PUT", URL_, part]);
    xhr.upload.onprogress!({ loaded: 2 });
    expect(onProgress).toHaveBeenCalledWith(2);
    xhr.respond(200, { ETag: '"abc"' });
    await expect(sent).resolves.toBe('"abc"');
  });

  it("fails without an ETag (CORS not exposing it): the part can't be completed", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const sent = putPart(URL_, part);
    FakeXhr.last.respond(200);
    await expect(sent).rejects.toBeInstanceOf(S3UploadError);
  });

  it.each([
    [403, true],
    [500, true],
    [400, false],
  ])("HTTP %i → S3UploadError, retryable %s", async (status, retryable) => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const sent = putPart(URL_, part);
    FakeXhr.last.respond(status);
    await expect(sent).rejects.toMatchObject({ status, retryable });
  });

  it("gives up a stalled part as retryable; a cancel is an AbortError", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const stalled = putPart(URL_, part);
    vi.advanceTimersByTime(STALL_TIMEOUT_MS);
    await expect(stalled).rejects.toMatchObject({ status: 0, retryable: true });

    const controller = new AbortController();
    const cancelled = putPart(URL_, part, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });
});
