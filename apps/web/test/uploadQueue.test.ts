import type { UploadUrlRequest } from "@photo-app/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/api";
import { ApiRequestError } from "../src/api/errors";
import {
  CONCURRENCY,
  PHONE_LIMIT,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  retryDelay,
  STORE_READ_TIMEOUT_MS,
  UNREADABLE_FILE,
} from "../src/upload/queue";
import { S3UploadError } from "../src/upload/s3Post";
import type { UploadItem } from "../src/upload/store";
import {
  controlledPost,
  FakeLocks,
  MemoryUploadStore,
  testFile,
  testId,
  testUploadQueue,
  testUser,
} from "./fakes";

const USER = testUser.sub;
const OTHER_USER = "04e8b4b8-0000-4000-8000-000000000002";
const UPLOAD = { url: "https://photos.s3.amazonaws.com/", fields: { key: "k", Policy: "p" } };

/** `POST /photos/upload-url`: a new photoId per new upload, the same one when re-signing (5.6a). */
function uploadApi(answer?: (body: UploadUrlRequest) => unknown) {
  let n = 0;
  const uploadUrl = vi.fn(async (body: UploadUrlRequest) => {
    const result = answer?.(body);
    if (result instanceof Error) throw result;
    return result ?? { photoId: body.photoId ?? testId(++n), upload: UPLOAD };
  });
  return { api: { photos: { uploadUrl } } as unknown as Pick<Api, "photos">, uploadUrl };
}

const statuses = (queue: { getSnapshot(): readonly UploadItem[] }) =>
  queue.getSnapshot().map((entry) => entry.status);

function storedItem(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id: "stored-1",
    userId: USER,
    file: testFile("IMG_1.jpg"),
    fileName: "IMG_1.jpg",
    contentType: "image/jpeg",
    sizeBytes: 1000,
    photoId: null,
    status: "queued",
    attempts: 0,
    retryAt: 0,
    error: null,
    errorCode: null,
    addedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("upload queue (§12.4, FR-UP-1/5/6)", () => {
  it("stores a file, uploads it straight to S3 and refreshes the gallery", async () => {
    const { api, uploadUrl } = uploadApi();
    const { post, calls } = controlledPost();
    const onUploaded = vi.fn();
    const { queue, store } = testUploadQueue(api, { post, onUploaded });
    await queue.start(USER);

    const file = testFile("IMG_1.jpg", 1234);
    expect(await queue.add([file])).toEqual({ added: 1, addedBytes: 1234, rejected: [] });
    // Persisted before anything is sent (FR-UP-5).
    expect([...store.items.values()][0]).toMatchObject({
      file,
      userId: USER,
      fileName: "IMG_1.jpg",
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(uploadUrl).toHaveBeenCalledWith({
      fileName: "IMG_1.jpg",
      contentType: "image/jpeg",
      sizeBytes: 1234,
      uploadId: "local-1",
    });
    expect(calls[0]!.upload).toEqual(UPLOAD);
    // Its own copy of the bytes (Android), not the picked File.
    expect(new Uint8Array(await calls[0]!.file.arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
    expect(calls[0]!.file.type).toBe(file.type);
    expect(queue.getSnapshot()[0]).toMatchObject({ status: "uploading", photoId: testId(1) });

    calls[0]!.progress(0.5);
    expect(queue.getSnapshot()[0]!.progress).toBe(0.5);

    calls[0]!.resolve();
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
    expect(onUploaded).toHaveBeenCalledTimes(1);
    // The bytes are in S3: not kept on the device.
    expect([...store.items.values()][0]).toMatchObject({ status: "done", file: null });
  });

  it("rejects files that can never upload, without queueing them (FR-UP-2/3)", async () => {
    const { api } = uploadApi();
    const { queue, store } = testUploadQueue(api);
    await queue.start(USER);

    const result = await queue.add([
      testFile("notes.pdf", 10, "application/pdf"),
      testFile("huge.jpg", 50 * 1024 * 1024 + 1),
      testFile("empty.png", 0, "image/png"),
      // Desktop browsers often give HEIC no type: the extension decides.
      testFile("IMG_2.HEIC", 10, ""),
    ]);

    expect(result.added).toBe(1);
    expect(result.rejected.map((r) => r.fileName)).toEqual(["notes.pdf", "huge.jpg", "empty.png"]);
    expect(result.rejected[1]!.reason).toBe("Larger than 50 MB");
    expect(result.rejected.map((r) => r.code)).toEqual(["type", "size", "empty"]);
    expect([...store.items.values()].map((i) => i.contentType)).toEqual(["image/heic"]);
  });

  it(`runs at most ${CONCURRENCY} uploads at once`, async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const { queue } = testUploadQueue(api, { post });
    await queue.start(USER);

    await queue.add([1, 2, 3, 4, 5].map((n) => testFile(`IMG_${n}.jpg`)));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(statuses(queue)).toEqual(["uploading", "uploading", "uploading", "queued", "queued"]);

    calls[0]!.resolve();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3]!.file).toBe(queue.getSnapshot()[3]!.file);
  });

  it("retries a temporary failure with backoff, re-signing the same photo (5.6a)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let time = 1_000_000;
    const { api, uploadUrl } = uploadApi();
    const { post, calls } = controlledPost();
    const { queue } = testUploadQueue(api, { post, now: () => time });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    calls[0]!.reject(new S3UploadError(0)); // connection dropped
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["queued"]));
    expect(queue.getSnapshot()[0]).toMatchObject({ attempts: 1, retryAt: time + RETRY_BASE_MS });

    time += RETRY_BASE_MS;
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(uploadUrl).toHaveBeenLastCalledWith(expect.objectContaining({ photoId: testId(1) }));
    // A new signature for each attempt (an old one may have expired).
    expect(uploadUrl).toHaveBeenCalledTimes(2);
  });

  it("backs off 2 s, 4 s, 8 s … up to 1 min", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelay)).toEqual([
      2000,
      4000,
      8000,
      16000,
      32000,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
    ]);
  });

  it.each([
    ["no network", new ApiRequestError("NETWORK_ERROR", "x", 0)],
    ["a server error", new ApiRequestError("INTERNAL_ERROR", "x", 500)],
    ["throttling", new ApiRequestError("RATE_LIMITED", "x", 429)],
    ["an ended session", new ApiRequestError("UNAUTHORIZED", "x", 401)],
  ])("retries later after %s from the API", async (_, error) => {
    const { api } = uploadApi(() => error);
    const { queue } = testUploadQueue(api);
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(queue.getSnapshot()[0]!.attempts).toBe(1));
    expect(statuses(queue)).toEqual(["queued"]);
  });

  it.each([
    ["S3 rejects an expired signature (403)", 403],
    ["S3 fails (503)", 503],
  ])("retries when %s", async (_, status) => {
    const { api } = uploadApi();
    const { queue } = testUploadQueue(api, {
      post: () => Promise.reject(new S3UploadError(status)),
    });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(queue.getSnapshot()[0]!.attempts).toBe(1));
    expect(statuses(queue)).toEqual(["queued"]);
  });

  it("stops at a permanent failure with a message, and retries when the user asks (FR-UP-7)", async () => {
    let full = true;
    const { api } = uploadApi(() =>
      full ? new ApiRequestError("QUOTA_EXCEEDED", "over quota", 413) : undefined,
    );
    const { queue } = testUploadQueue(api);
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);

    await vi.waitFor(() => expect(statuses(queue)).toEqual(["failed"]));
    expect(queue.getSnapshot()[0]).toMatchObject({
      error: "Your storage is full. Delete some photos to upload more.",
      errorCode: "QUOTA_EXCEEDED",
    });

    full = false;
    await queue.retry(queue.getSnapshot()[0]!.id);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
    expect(queue.getSnapshot()[0]).toMatchObject({ error: null, errorCode: null });
  });

  it("retries every failed upload at once (8.14), leaving the others alone", async () => {
    let full = true;
    const { api } = uploadApi(() =>
      full ? new ApiRequestError("QUOTA_EXCEEDED", "over quota", 413) : undefined,
    );
    const store = new MemoryUploadStore();
    await store.put(storedItem({ id: "done", status: "done", file: null, addedAt: 0 }));
    const { queue } = testUploadQueue(api, { store });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["failed", "failed"]));

    full = false;
    await queue.retryAll();
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done", "done"]));
  });

  it("marks a file that vanished from the device", async () => {
    const store = new MemoryUploadStore();
    await store.put(storedItem({ file: null }));
    const { queue } = testUploadQueue(uploadApi().api, { store });
    await queue.start(USER);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["failed"]));
    expect(queue.getSnapshot()[0]!.errorCode).toBe("FILE_MISSING");
  });

  it("fails for good when S3 rejects the request itself (400)", async () => {
    const { api } = uploadApi();
    const { queue } = testUploadQueue(api, { post: () => Promise.reject(new S3UploadError(400)) });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["failed"]));
    expect(queue.getSnapshot()[0]).toMatchObject({
      error:
        "This file couldn't be uploaded. It may have changed since you picked it. Remove it and add it again.",
      errorCode: "S3_REJECTED",
    });
  });

  it("starts afresh when the pending photo to re-sign is gone (404)", async () => {
    const { api, uploadUrl } = uploadApi((body) =>
      body.photoId ? new ApiRequestError("NOT_FOUND", "gone", 404) : undefined,
    );
    const store = new MemoryUploadStore();
    await store.put(storedItem({ photoId: testId(77), attempts: 1 }));
    const { queue } = testUploadQueue(api, { store });
    await queue.start(USER);

    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
    expect(uploadUrl.mock.calls.map(([body]) => body.photoId)).toEqual([testId(77), undefined]);
    expect(queue.getSnapshot()[0]!.photoId).toBe(testId(1));
  });

  it("counts a 409 as done without a stored photoId too (found by uploadId)", async () => {
    const { api } = uploadApi(() => new ApiRequestError("CONFLICT", "uploaded", 409));
    const { queue } = testUploadQueue(api);
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
  });

  it("counts a 409 on re-sign as done: an earlier attempt already reached S3", async () => {
    const { api } = uploadApi(() => new ApiRequestError("CONFLICT", "uploaded", 409));
    const post = vi.fn();
    const onUploaded = vi.fn();
    const store = new MemoryUploadStore();
    await store.put(storedItem({ photoId: testId(5) }));
    const { queue } = testUploadQueue(api, { store, post, onUploaded });
    await queue.start(USER);

    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
    expect(post).not.toHaveBeenCalled();
    expect(onUploaded).toHaveBeenCalled();
  });

  it("resumes after a reload: an interrupted upload continues with its photo (FR-UP-5)", async () => {
    const store = new MemoryUploadStore();
    const first = uploadApi();
    const { post, calls } = controlledPost();
    const before = testUploadQueue(first.api, { store, post });
    await before.queue.start(USER);
    await before.queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    before.queue.stop(); // the tab closes mid-upload
    expect([...store.items.values()][0]).toMatchObject({ status: "uploading", photoId: testId(1) });

    const second = uploadApi();
    const after = testUploadQueue(second.api, { store });
    await after.queue.start(USER);
    await vi.waitFor(() => expect(statuses(after.queue)).toEqual(["done"]));
    expect(second.uploadUrl).toHaveBeenCalledWith(expect.objectContaining({ photoId: testId(1) }));
  });

  it("forgets uploads finished in an earlier session on start", async () => {
    const store = new MemoryUploadStore();
    await store.put(storedItem({ id: "old", status: "done", file: null, photoId: testId(1) }));
    await store.put(storedItem({ id: "failed", status: "failed", error: "x", addedAt: 2 }));
    const { queue } = testUploadQueue(uploadApi().api, { store });
    await queue.start(USER);
    await vi.waitFor(() => expect([...store.items.keys()]).toEqual(["failed"]));
    expect(statuses(queue)).toEqual(["failed"]);
  });

  it("waits while offline and uploads on the online event", async () => {
    let online = false;
    const { api, uploadUrl } = uploadApi();
    const { queue } = testUploadQueue(api, { isOnline: () => online });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uploadUrl).not.toHaveBeenCalled();

    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
  });

  it("never uploads another account's files queued on the same device", async () => {
    const store = new MemoryUploadStore();
    await store.put(storedItem({ userId: OTHER_USER }));
    const { api, uploadUrl } = uploadApi();
    const { queue } = testUploadQueue(api, { store });
    await queue.start(USER);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.getSnapshot()).toEqual([]);
    expect(uploadUrl).not.toHaveBeenCalled();
    expect(store.items.size).toBe(1);
  });

  it("cancels a running upload when it is removed", async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const { queue, store } = testUploadQueue(api, { post });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await queue.remove(queue.getSnapshot()[0]!.id);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(queue.getSnapshot()).toEqual([]);
    expect(store.items.size).toBe(0);
  });

  it("clears everything (logout, 8.13)", async () => {
    const store = new MemoryUploadStore();
    await store.put(storedItem({ status: "failed" }));
    await store.put(storedItem({ id: "other", userId: OTHER_USER }));
    const { queue } = testUploadQueue(uploadApi().api, { store });
    await queue.start(USER);
    await queue.clear();
    expect(store.items.size).toBe(0);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it("uploads only in the tab that holds the lock", async () => {
    let grant: (() => void) | undefined;
    const locks = {
      request: vi.fn(
        (_name: string, _options: LockOptions, callback: () => Promise<void> | undefined) =>
          new Promise<void>((resolve) => {
            grant = () => void Promise.resolve(callback()).then(resolve);
          }),
      ),
    } as unknown as LockManager;
    const { api, uploadUrl } = uploadApi();
    const { queue } = testUploadQueue(api, { locks });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uploadUrl).not.toHaveBeenCalled(); // another tab is uploading
    expect(statuses(queue)).toEqual(["queued"]);

    grant!(); // that tab closed
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
  });
});

describe("upload queue at scale (13.1-0)", () => {
  it("refreshes the gallery at once, then at most once per interval, without holding a slot", async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const onUploaded = vi.fn();
    const { queue } = testUploadQueue(api, { post, onUploaded, refreshEveryMs: 300 });
    await queue.start(USER);
    await queue.add([1, 2, 3, 4, 5, 6].map((n) => testFile(`IMG_${n}.jpg`)));
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    calls[0]!.resolve();
    await vi.waitFor(() => expect(statuses(queue)[0]).toBe("done"));
    expect(onUploaded).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(calls).toHaveLength(4));

    calls[1]!.resolve();
    calls[2]!.resolve();
    // Their slots go to the next files at once…
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    // …while they stay on screen as uploaded-but-not-yet-shown until the next refresh.
    expect(queue.getSnapshot().slice(1, 3)).toMatchObject([
      { status: "uploading", progress: 1 },
      { status: "uploading", progress: 1 },
    ]);
    expect(onUploaded).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(statuses(queue).slice(0, 3)).toEqual(["done", "done", "done"]));
    expect(onUploaded).toHaveBeenCalledTimes(2);
  });

  it("keeps going when the refresh fails", async () => {
    const { api } = uploadApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queue } = testUploadQueue(api, {
      onUploaded: () => Promise.reject(new Error("offline")),
    });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("tells the UI once per frame; the snapshot is always current and keeps unchanged entries", async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const frames: (() => void)[] = [];
    const { queue } = testUploadQueue(api, { post, scheduleFrame: (cb) => frames.push(cb) });
    const listener = vi.fn();
    queue.subscribe(listener);
    await queue.start(USER);
    await queue.add([1, 2].map((n) => testFile(`IMG_${n}.jpg`)));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    frames.splice(0).forEach((frame) => frame());

    const before = queue.getSnapshot();
    for (let i = 1; i <= 10; i++) calls[0]!.progress(i / 10);
    expect(frames).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    const after = queue.getSnapshot();
    expect(after[0]!.progress).toBe(1);
    // Stable between changes (useSyncExternalStore), and the other row didn't change.
    expect(queue.getSnapshot()).toBe(after);
    expect(after[1]).toBe(before[1]);

    frames.splice(0).forEach((frame) => frame());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("handles 5,000 files: 3 at a time, in the order added", async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const frames: (() => void)[] = [];
    const { queue } = testUploadQueue(api, {
      post,
      refreshEveryMs: 0,
      scheduleFrame: (cb) => frames.push(cb),
    });
    await queue.start(USER);
    const files = Array.from({ length: 5000 }, (_, i) => testFile(`IMG_${i}.jpg`, 10));

    const started = performance.now();
    expect((await queue.add(files)).added).toBe(5000);
    // Linear work per file (it was quadratic): generous, to stay stable on slow CI machines.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(queue.getSnapshot()).toHaveLength(5000);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    // One notification for the whole batch, not one per file.
    expect(frames.length).toBeLessThanOrEqual(1);

    for (let i = 0; i < 5; i++) {
      calls[i]!.resolve();
      await vi.waitFor(() => expect(calls).toHaveLength(4 + i));
    }
    expect(calls.map((call) => (call.file as File).name ?? "")).toHaveLength(8);
    const uploading = queue
      .getSnapshot()
      .filter((entry) => entry.status === "uploading" && entry.progress < 1)
      .map((entry) => entry.fileName);
    expect(uploading).toEqual(["IMG_5.jpg", "IMG_6.jpg", "IMG_7.jpg"]);
  });
});

describe("large batches stay in the tab that picked them (13.1c)", () => {
  /** Two 1,000-byte files are a large batch with this threshold. */
  const LARGE = 1500;

  it("reads a large pick from the disk at upload time and stores nothing", async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const requestPersistence = vi.fn();
    const { queue, store } = testUploadQueue(api, {
      post,
      largeBatchBytes: LARGE,
      requestPersistence,
    });
    await queue.start(USER);
    const files = [testFile("IMG_1.jpg"), testFile("IMG_2.jpg")];
    const read = vi.spyOn(files[0]!, "arrayBuffer");

    expect(await queue.add(files)).toMatchObject({ added: 2, addedBytes: 2000 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // The picked files themselves, not copies; nothing in IndexedDB.
    expect(calls[0]!.file).toBe(files[0]);
    expect(read).not.toHaveBeenCalled();
    expect(store.items.size).toBe(0);
    expect(queue.getSnapshot().every((entry) => entry.memoryOnly)).toBe(true);
    expect(requestPersistence).not.toHaveBeenCalled();

    calls[0]!.resolve();
    calls[1]!.resolve();
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done", "done"]));
    expect(store.items.size).toBe(0);
  });

  it("treats a folder as a large batch whatever its size", async () => {
    const { api } = uploadApi();
    const { queue, store } = testUploadQueue(api, { post: () => new Promise(() => {}) });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")], { folder: true });
    expect(queue.getSnapshot()[0]!.memoryOnly).toBe(true);
    expect(store.items.size).toBe(0);
  });

  it("keeps small picks stored and copied, as before", async () => {
    const { api } = uploadApi();
    const { queue, store } = testUploadQueue(api, {
      post: () => new Promise(() => {}),
      largeBatchBytes: LARGE,
    });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    expect(queue.getSnapshot()[0]!.memoryOnly).toBeUndefined();
    await vi.waitFor(() => expect(store.items.size).toBe(1));
  });

  it("fails a file that was moved or deleted since it was picked, without retrying", async () => {
    const { api, uploadUrl } = uploadApi();
    const { queue } = testUploadQueue(api, { largeBatchBytes: LARGE });
    await queue.start(USER);
    const gone = testFile("IMG_1.jpg");
    vi.spyOn(gone, "slice").mockReturnValue({
      arrayBuffer: () => Promise.reject(new DOMException("gone", "NotFoundError")),
    } as unknown as Blob);

    await queue.add([gone, testFile("IMG_2.jpg")]);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["failed", "done"]));
    expect(queue.getSnapshot()[0]).toMatchObject({ errorCode: "FILE_MISSING" });
    expect(uploadUrl).toHaveBeenCalledOnce();
  });

  it("phones copy every pick, up to 1 GB, and say why the rest wasn't added", async () => {
    const { api } = uploadApi();
    const { queue, store } = testUploadQueue(api, {
      post: () => new Promise(() => {}),
      isPhone: () => true,
      largeBatchBytes: LARGE,
    });
    await queue.start(USER);
    // 25 photos of 45 MB = 1,125 MB (sizes faked; the bytes are a few).
    const files = Array.from({ length: 25 }, (_, i) => {
      const file = testFile(`IMG_${i}.jpg`, 10);
      Object.defineProperty(file, "size", { value: 45 * 1024 * 1024 });
      return file;
    });

    const result = await queue.add(files);
    expect(result.added).toBe(22);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected[0]).toEqual({
      fileName: "IMG_22.jpg",
      reason: PHONE_LIMIT,
      code: "phoneLimit",
    });
    // Copied and stored as before, not a large batch.
    expect(queue.getSnapshot().some((entry) => entry.memoryOnly)).toBe(false);
    await vi.waitFor(() => expect(store.items.size).toBe(22));
  });
});

describe("the whole queue: pause, resume, cancel (13.1d)", () => {
  it("pauses everything: running uploads stop, nothing starts, the pause is stored", async () => {
    const { api, uploadUrl } = uploadApi();
    const { post, calls } = controlledPost();
    const { queue, store } = testUploadQueue(api, { post });
    await queue.start(USER);
    await queue.add([1, 2, 3, 4].map((n) => testFile(`IMG_${n}.jpg`)));
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    await queue.pause();
    expect(calls.every((call) => call.signal?.aborted)).toBe(true);
    expect(queue.getSnapshot().map((e) => [e.status, e.paused])).toEqual([
      ["queued", true],
      ["queued", true],
      ["queued", true],
      ["queued", true],
    ]);
    // Stored, so another tab or the service worker leaves them alone too.
    await vi.waitFor(() => expect([...store.items.values()].every((i) => i.paused)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(uploadUrl).toHaveBeenCalledTimes(3);

    await queue.resume();
    // They start over, re-signing the same photos (5.6a).
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    expect(uploadUrl).toHaveBeenLastCalledWith(expect.objectContaining({ photoId: testId(3) }));
    expect(queue.getSnapshot().some((e) => e.paused)).toBe(false);
  });

  it("cancels every unfinished upload, keeping the finished ones", async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const { queue, store } = testUploadQueue(api, { post });
    await queue.start(USER);
    await queue.add([1, 2, 3, 4].map((n) => testFile(`IMG_${n}.jpg`)));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[0]!.resolve();
    await vi.waitFor(() => expect(statuses(queue)[0]).toBe("done"));

    await queue.cancelAll();
    expect(statuses(queue)).toEqual(["done"]);
    expect(calls.slice(1, 3).every((call) => call.signal?.aborted)).toBe(true);
    await vi.waitFor(() => expect(store.items.size).toBe(1));
  });
});

describe("storage full (13.1e, FR-UP-7)", () => {
  const full = () => new ApiRequestError("QUOTA_EXCEEDED", "Not enough storage", 413);

  it("stops every waiting file at the first refusal, without asking the server for each", async () => {
    let refuse = false;
    const { api, uploadUrl } = uploadApi(() => (refuse ? full() : undefined));
    const { post, calls } = controlledPost();
    const { queue } = testUploadQueue(api, { post });
    await queue.start(USER);
    await queue.add([1, 2, 3, 4, 5, 6].map((n) => testFile(`IMG_${n}.jpg`)));
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    // Storage runs out: the next file is refused…
    refuse = true;
    calls[0]!.resolve();
    await vi.waitFor(() => expect(statuses(queue)[3]).toBe("failed"));
    // …and the ones behind it stop as well, untried; running uploads carry on.
    expect(statuses(queue)).toEqual([
      "done",
      "uploading",
      "uploading",
      "failed",
      "failed",
      "failed",
    ]);
    expect(uploadUrl).toHaveBeenCalledTimes(4);
    expect(
      queue
        .getSnapshot()
        .slice(3)
        .map((e) => e.errorCode),
    ).toEqual(["QUOTA_EXCEEDED", "QUOTA_EXCEEDED", "QUOTA_EXCEEDED"]);

    // Space freed: Retry all sends them again.
    refuse = false;
    await queue.retryAll();
    await vi.waitFor(() => expect(uploadUrl).toHaveBeenCalledTimes(5));
  });
});

describe("upload queue: files from the device (Android, 2026-10-26)", () => {
  it("keeps its own copy of the bytes, read when the file is added", async () => {
    const store = new MemoryUploadStore();
    const { queue } = testUploadQueue(uploadApi().api, {
      store,
      post: () => new Promise(() => {}),
    });
    await queue.start(USER);
    const picked = testFile("IMG_1.jpg", 1234);
    await queue.add([picked]);

    const stored = [...store.items.values()][0]!;
    expect(stored.file).not.toBe(picked);
    expect(stored.file!.size).toBe(1234);
    expect(stored.file!.type).toBe("image/jpeg");
  });

  it("rejects a file whose bytes can't be read, and adds the rest", async () => {
    const { queue } = testUploadQueue(uploadApi().api, { post: () => new Promise(() => {}) });
    await queue.start(USER);
    const unreadable = testFile("cloud.jpg");
    unreadable.arrayBuffer = () => Promise.reject(new DOMException("gone", "NotReadableError"));
    const result = await queue.add([unreadable, testFile("IMG_2.jpg")]);

    expect(result.added).toBe(1);
    expect(result.rejected).toEqual([
      { fileName: "cloud.jpg", reason: UNREADABLE_FILE, code: "unreadable" },
    ]);
  });

  it("keeps uploading when saving the queue to IndexedDB fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new MemoryUploadStore();
    const { api, uploadUrl } = uploadApi();
    const { queue } = testUploadQueue(api, { store });
    await queue.start(USER);
    vi.spyOn(store, "put").mockRejectedValue(
      new DOMException("Failed to write blobs (InvalidBlob)", "UnknownError"),
    );
    await queue.add([testFile("IMG_1.jpg")]);

    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
    expect(uploadUrl).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("adds and uploads everything while IndexedDB writes never finish (Android, 2026-10-28)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new MemoryUploadStore();
    const { api } = uploadApi();
    const { queue } = testUploadQueue(api, { store });
    await queue.start(USER);
    vi.spyOn(store, "put").mockReturnValue(new Promise(() => {}));
    const files = [1, 2, 3, 4, 5].map((n) => testFile(`IMG_${n}.jpg`));
    expect((await queue.add(files)).added).toBe(5);
    // Each upload waits at most STORE_READ_TIMEOUT_MS for its photoId to be stored.
    await vi.advanceTimersByTimeAsync(STORE_READ_TIMEOUT_MS * 2);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(Array(5).fill("done")));
  });

  it("stores the photoId before the file goes out, so a closed app doesn't upload a duplicate", async () => {
    const store = new MemoryUploadStore();
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    let release!: () => void;
    const { queue } = testUploadQueue(api, { store, post });
    await queue.start(USER);
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (item) => {
      // The write with the photoId is slow (a big Blob), but lands.
      if (item.photoId) await new Promise<void>((resolve) => (release = resolve));
      await put(item);
    });
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(calls).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect([...store.items.values()][0]!.photoId).toBe(testId(1));
  });

  it("starts uploading the first picked files while the rest are still being read", async () => {
    const { api } = uploadApi();
    const { post, calls } = controlledPost();
    const { queue } = testUploadQueue(api, { post });
    await queue.start(USER);
    let finishRead!: (bytes: ArrayBuffer) => void;
    const slow = testFile("IMG_2.jpg");
    vi.spyOn(slow, "arrayBuffer").mockReturnValue(new Promise((resolve) => (finishRead = resolve)));
    const added = queue.add([testFile("IMG_1.jpg"), slow]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    finishRead(new ArrayBuffer(1000));
    expect((await added).added).toBe(2);
  });

  it("starts uploading when reading the stored queue never finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new MemoryUploadStore();
    vi.spyOn(store, "list").mockReturnValue(new Promise(() => {}));
    const { api } = uploadApi();
    const { queue } = testUploadQueue(api, {
      store,
      locks: new FakeLocks() as unknown as LockManager,
    });
    const started = queue.start(USER);
    await vi.advanceTimersByTimeAsync(STORE_READ_TIMEOUT_MS);
    await started;
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.advanceTimersByTimeAsync(STORE_READ_TIMEOUT_MS);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
  });

  it("Retry still uploads when saving fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new MemoryUploadStore();
    let calls = 0;
    // First attempt refused for good, the retry accepted.
    const { api } = uploadApi(() =>
      ++calls === 1 ? new ApiRequestError("VALIDATION_ERROR", "bad", 400) : undefined,
    );
    const { queue } = testUploadQueue(api, { store });
    await queue.start(USER);
    await queue.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["failed"]));

    vi.spyOn(store, "put").mockRejectedValue(new DOMException("blocked", "UnknownError"));
    await queue.retry(queue.getSnapshot()[0]!.id);
    await vi.waitFor(() => expect(statuses(queue)).toEqual(["done"]));
    warn.mockRestore();
  });
});
