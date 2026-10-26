import { afterEach, describe, expect, it, vi } from "vitest";
import { postToS3, postToS3WithFetch, S3UploadError } from "../src/upload/s3Post";

/** Just enough XMLHttpRequest to drive postToS3. */
class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  body: FormData | undefined;
  status = 0;
  aborted = false;
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
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }
}

const upload = { url: "https://photos.s3.amazonaws.com/", fields: { key: "k", Policy: "p" } };
const file = new Blob(["abc"], { type: "image/jpeg" });

afterEach(() => vi.unstubAllGlobals());

describe("postToS3 (FR-UP-4)", () => {
  it("posts the signed fields then the file, reporting progress", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const onProgress = vi.fn();
    const sent = postToS3(upload, file, { onProgress });
    const xhr = FakeXhr.last;

    expect([xhr.method, xhr.url]).toEqual(["POST", upload.url]);
    // S3 requires the file to be the last field.
    expect([...xhr.body!.keys()]).toEqual(["key", "Policy", "file"]);
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 4 });
    expect(onProgress).toHaveBeenCalledWith(0.25);

    xhr.respond(204);
    await expect(sent).resolves.toBeUndefined();
  });

  it.each([
    [403, true],
    [500, true],
    [400, false],
  ])("rejects HTTP %i with retryable = %s", async (status, retryable) => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const sent = postToS3(upload, file);
    FakeXhr.last.respond(status);
    const error = await sent.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3UploadError);
    expect((error as S3UploadError).retryable).toBe(retryable);
  });

  it("treats no response as a retryable failure", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const sent = postToS3(upload, file);
    FakeXhr.last.onerror!();
    await expect(sent).rejects.toMatchObject({ status: 0, retryable: true });
  });

  it("aborts with the signal", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const controller = new AbortController();
    const sent = postToS3(upload, file, { signal: controller.signal });
    controller.abort();
    await expect(sent).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.last.aborted).toBe(true);
  });
});

describe("postToS3WithFetch (service worker, 9.5)", () => {
  it("posts the signed fields then the file", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    await postToS3WithFetch(fetch)(upload, file);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(upload.url);
    expect(init?.method).toBe("POST");
    expect([...(init!.body as FormData).keys()]).toEqual(["key", "Policy", "file"]);
  });

  it("fails like the XHR version: S3 errors by status, no response as status 0", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(postToS3WithFetch(fetch)(upload, file)).rejects.toMatchObject({
      status: 403,
      retryable: true,
    });
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(postToS3WithFetch(fetch)(upload, file)).rejects.toBeInstanceOf(S3UploadError);
  });

  it("aborts with the signal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      postToS3WithFetch(fetch)(upload, file, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
