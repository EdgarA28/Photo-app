import type { UploadUrlRequest } from "@photo-app/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/api";
import { ApiRequestError } from "../src/api/errors";
import {
  SYNC_TIME_BUDGET_MS,
  uploadInBackground,
  type BackgroundUploadDeps,
} from "../src/pwa/backgroundUploads";
import { LOCK_NAME, TAKEOVER_AFTER_MS, type UploadMessage } from "../src/upload/queue";
import type { UploadItem } from "../src/upload/store";
import {
  channelHub,
  controlledPost,
  FakeLocks,
  MemoryUploadStore,
  testId,
  testUser,
} from "./fakes";

// Background Sync (9.5): the service worker uploads the stored queue, e.g. after the app was
// closed with uploads waiting, or while Android keeps the backgrounded app frozen.

const SESSION = { sub: testUser.sub, refreshToken: "refresh-1" };
const UPLOAD = { url: "https://photos.s3.amazonaws.com/", fields: { key: "k", Policy: "p" } };

const item = (id: string, overrides: Partial<UploadItem> = {}): UploadItem => ({
  id,
  userId: testUser.sub,
  file: new Blob(["x"], { type: "image/jpeg" }),
  fileName: `${id}.jpg`,
  contentType: "image/jpeg",
  sizeBytes: 1,
  photoId: null,
  status: "queued",
  attempts: 0,
  retryAt: 0,
  error: null,
  errorCode: null,
  addedAt: Number(id.replace(/\D/g, "")) || 0,
  ...overrides,
});

let store: MemoryUploadStore;
let locks: FakeLocks;
let hub: ReturnType<typeof channelHub>;
/** What a tab hears from the service worker. */
let heard: UploadMessage[];
let tab: BroadcastChannel;
let uploadUrl: ReturnType<typeof vi.fn<(body: UploadUrlRequest) => Promise<unknown>>>;
let session: { readonly ended: boolean };
let ended: boolean;

function deps(overrides: Partial<BackgroundUploadDeps> = {}): BackgroundUploadDeps {
  return {
    readSession: async () => SESSION,
    connect: () => ({
      api: { photos: { uploadUrl } } as unknown as Pick<Api, "photos">,
      auth: session,
    }),
    store,
    post: async () => {},
    locks: locks as unknown as LockManager,
    createChannel: () => hub.create().channel,
    ...overrides,
  };
}

const status = (id: string) => store.items.get(id)?.status;

beforeEach(() => {
  vi.useFakeTimers();
  store = new MemoryUploadStore();
  locks = new FakeLocks();
  hub = channelHub();
  heard = [];
  tab = hub.create().channel;
  tab.addEventListener("message", (event) => heard.push((event as MessageEvent).data));
  let n = 0;
  uploadUrl = vi.fn(async (body: UploadUrlRequest) => ({
    photoId: body.photoId ?? testId(++n),
    upload: UPLOAD,
  }));
  ended = false;
  session = {
    get ended() {
      return ended;
    },
  };
});
afterEach(() => vi.useRealTimers());

/** A tab holding the lock (the app open, maybe frozen); `release` closes it. */
function tabHoldsLock() {
  let release!: () => void;
  let stolen = false;
  const held = locks.request(
    LOCK_NAME,
    {},
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  held.catch((error: unknown) => {
    stolen = error instanceof DOMException && error.name === "AbortError";
  });
  return { stolen: () => stolen, release: () => release() };
}

describe("background uploads (9.5)", () => {
  it("uploads the waiting queue when no tab is uploading (the app was closed)", async () => {
    await store.put(item("local-1"));
    await store.put(item("local-2", { status: "uploading", photoId: testId(9) }));
    await store.put(item("local-3", { status: "failed", error: "Storage full" }));
    await store.put(item("local-4", { status: "done", file: null }));
    await store.put(item("other", { userId: "someone-else" }));

    await uploadInBackground(deps());

    expect(status("local-1")).toBe("done");
    expect(status("local-2")).toBe("done");
    expect(store.items.get("local-1")!.file).toBeNull();
    // A re-sign of the pending photo, no duplicate (5.6a).
    expect(uploadUrl).toHaveBeenCalledWith(expect.objectContaining({ photoId: testId(9) }));
    expect(status("local-3")).toBe("failed");
    expect(status("other")).toBe("queued");
    expect(uploadUrl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toContainEqual({ type: "working" });
    expect(heard).toContainEqual({ type: "changed" });
  });

  it("leaves uploads the user paused alone (13.1d)", async () => {
    await store.put(item("local-1", { paused: true }));
    await store.put(item("local-2"));
    await uploadInBackground(deps());
    expect(status("local-1")).toBe("queued");
    expect(status("local-2")).toBe("done");
    expect(uploadUrl).toHaveBeenCalledOnce();
  });

  it("does nothing without a session or without waiting uploads", async () => {
    const request = vi.spyOn(locks, "request");
    await uploadInBackground(deps({ readSession: async () => null }));
    await store.put(item("local-1", { status: "failed" }));
    await uploadInBackground(deps());
    expect(request).not.toHaveBeenCalled();
    expect(uploadUrl).not.toHaveBeenCalled();
  });

  it("asks the browser for a retry after a temporary failure", async () => {
    await store.put(item("local-1"));
    uploadUrl.mockRejectedValueOnce(new ApiRequestError("INTERNAL_ERROR", "HTTP 503", 503));
    await expect(uploadInBackground(deps())).rejects.toThrow(/retry/);
    expect(store.items.get("local-1")).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("marks permanent failures for the user without a retry", async () => {
    await store.put(item("local-1"));
    uploadUrl.mockRejectedValueOnce(new ApiRequestError("QUOTA_EXCEEDED", "Full", 413));
    await uploadInBackground(deps());
    expect(store.items.get("local-1")).toMatchObject({
      status: "failed",
      errorCode: "QUOTA_EXCEEDED",
    });
  });

  it("stops without a retry when the session has ended", async () => {
    await store.put(item("local-1"));
    await store.put(item("local-2"));
    await store.put(item("local-3"));
    await store.put(item("local-4"));
    uploadUrl.mockImplementation(async () => {
      ended = true;
      throw new ApiRequestError("UNAUTHORIZED", "Not signed in", 401);
    });
    await uploadInBackground(deps());
    // The first three (in parallel) were tried; the fourth wasn't. All wait for the app.
    expect(uploadUrl).toHaveBeenCalledTimes(3);
    expect(status("local-4")).toBe("queued");
  });

  it("leaves the uploads to a tab that is making progress", async () => {
    await store.put(item("local-1", { status: "uploading" }));
    const { release } = tabHoldsLock();
    const run = uploadInBackground(deps());
    await vi.advanceTimersByTimeAsync(1000);
    tab.postMessage({ type: "progress", id: "local-1", progress: 0.5 });
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(uploadUrl).not.toHaveBeenCalled();
    expect(status("local-1")).toBe("uploading");
    release();
  });

  it("takes over from a tab that makes no progress (frozen in the background)", async () => {
    await store.put(item("local-1", { status: "uploading" }));
    const { stolen } = tabHoldsLock();
    const run = uploadInBackground(deps());
    await vi.advanceTimersByTimeAsync(TAKEOVER_AFTER_MS);
    await run;
    expect(stolen()).toBe(true);
    expect(status("local-1")).toBe("done");
  });

  it("stops when a tab takes the lock back (the app was opened)", async () => {
    await store.put(item("local-1"));
    const s3 = controlledPost();
    const run = uploadInBackground(deps({ post: s3.post }));
    await vi.advanceTimersByTimeAsync(0);
    expect(s3.calls).toHaveLength(1);

    void locks.request(LOCK_NAME, { steal: true }, () => new Promise(() => {}));
    await run;
    expect(s3.calls[0]!.signal?.aborted).toBe(true);
    // The tab starts it again (its lead() resets `uploading`).
    expect(status("local-1")).toBe("uploading");
  });

  it("tells open tabs it is working, so they don't take over", async () => {
    await store.put(item("local-1"));
    const s3 = controlledPost();
    const run = uploadInBackground(deps({ post: s3.post }));
    await vi.advanceTimersByTimeAsync(0);
    heard = [];
    await vi.advanceTimersByTimeAsync(TAKEOVER_AFTER_MS);
    expect(heard.filter((m) => m.type === "working").length).toBeGreaterThanOrEqual(3);
    s3.calls[0]!.resolve();
    await run;
  });

  it("stops in time and asks for a retry (Chromium ends a sync after 3 minutes)", async () => {
    await store.put(item("local-1"));
    await store.put(item("local-2"));
    const s3 = controlledPost();
    const run = uploadInBackground(deps({ post: s3.post }));
    const settled = run.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(SYNC_TIME_BUDGET_MS);
    expect(await settled).toBe("rejected");
    expect(s3.calls.every((call) => call.signal?.aborted)).toBe(true);
  });

  it("cancels an upload removed in a tab meanwhile, without bringing it back", async () => {
    await store.put(item("local-1"));
    const s3 = controlledPost();
    const run = uploadInBackground(deps({ post: s3.post }));
    await vi.advanceTimersByTimeAsync(0);

    await store.delete("local-1");
    tab.postMessage({ type: "changed" });
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(s3.calls[0]!.signal?.aborted).toBe(true);
    expect(store.items.has("local-1")).toBe(false);
  });
});
