import type { UploadUrlRequest } from "@photo-app/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/api";
import { TAKEOVER_CHECK_MS, TAKEOVER_AFTER_MS, type UploadQueue } from "../src/upload/queue";
import type { PostToS3 } from "../src/upload/s3Post";
import type { UploadItem } from "../src/upload/store";
import { MemoryUploadStore, testFile, testId, testUploadQueue, testUser } from "./fakes";

// Two windows of the app on one device (e.g. a Chrome tab and the installed PWA on Android) share
// the stored queue; one holds the lock and uploads. Found in dev: the uploading one was in the
// background, so the visible one showed "Waiting" for good.

const USER = testUser.sub;
const UPLOAD = { url: "https://photos.s3.amazonaws.com/", fields: { key: "k", Policy: "p" } };

/** Web Locks with one exclusive lock, a waiting line, `signal` and `steal`. */
class FakeLocks {
  holder: { reject: (error: unknown) => void } | null = null;
  waiting: { grant: () => void }[] = [];

  request(_name: string, options: LockOptions, callback: () => Promise<void> | undefined) {
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        const held = { reject };
        this.holder = held;
        void Promise.resolve(callback()).then(() => {
          if (this.holder === held) {
            this.holder = null;
            this.waiting.shift()?.grant();
          }
          resolve();
        });
      };
      if (options.steal) {
        const old = this.holder;
        this.holder = null;
        old?.reject(new DOMException("Lock stolen", "AbortError"));
        return grant();
      }
      if (!this.holder) return grant();
      const entry = { grant };
      this.waiting.push(entry);
      options.signal?.addEventListener("abort", () => {
        this.waiting = this.waiting.filter((e) => e !== entry);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}

/** BroadcastChannel between the windows; a frozen window neither sends nor receives. */
function channelHub() {
  const members = new Set<{ frozen: boolean; listeners: Set<(e: MessageEvent) => void> }>();
  const create = () => {
    const member = { frozen: false, listeners: new Set<(e: MessageEvent) => void>() };
    members.add(member);
    const channel = {
      postMessage(data: unknown) {
        if (member.frozen) return;
        for (const other of members) {
          if (other === member || other.frozen) continue;
          for (const listener of other.listeners) {
            queueMicrotask(() => listener(new MessageEvent("message", { data })));
          }
        }
      },
      addEventListener: (_type: string, listener: (e: MessageEvent) => void) =>
        member.listeners.add(listener),
      removeEventListener: (_type: string, listener: (e: MessageEvent) => void) =>
        member.listeners.delete(listener),
      close: () => members.delete(member),
    };
    return { channel: channel as unknown as BroadcastChannel, member };
  };
  return { create };
}

function uploadApi({ hang = false } = {}) {
  let n = 0;
  /** Answers the requests that hung (a frozen window thawing). */
  const pending: (() => void)[] = [];
  const uploadUrl = vi.fn(
    (body: UploadUrlRequest) =>
      new Promise((resolve) => {
        const answer = () => resolve({ photoId: body.photoId ?? testId(++n), upload: UPLOAD });
        if (hang) pending.push(answer);
        else answer();
      }),
  );
  const release = () => pending.splice(0).forEach((answer) => answer());
  return { api: { photos: { uploadUrl } } as unknown as Pick<Api, "photos">, uploadUrl, release };
}

const statuses = (queue: UploadQueue) =>
  queue.getSnapshot().map((entry: UploadItem) => entry.status);

/** Longest a waiting window takes to act: the first check starts the grace, a later one ends it. */
const TAKEOVER_WAIT = TAKEOVER_AFTER_MS + 2 * TAKEOVER_CHECK_MS;

let clock = 0;
/** Moves both the queue's clock and its intervals forward, in step (each check sees its time). */
async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 500) {
    const step = Math.min(500, left);
    clock += step;
    await vi.advanceTimersByTimeAsync(step);
  }
}

beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => vi.useRealTimers());

/** Window A (holds the lock first) and window B, on one stored queue. */
async function twoWindows({ aHangs = false, bVisible = true } = {}) {
  const locks = new FakeLocks();
  const hub = channelHub();
  const store = new MemoryUploadStore();
  const a = hub.create();
  const b = hub.create();
  const visible = { a: false, b: bVisible };
  const apiA = uploadApi({ hang: aHangs });
  const apiB = uploadApi();
  const postA = vi.fn<PostToS3>(async () => {});
  const postB = vi.fn<PostToS3>(async () => {});
  let bIds = 0;
  const uploadedA = vi.fn();
  const uploadedB = vi.fn();
  const common = { store, locks: locks as unknown as LockManager, now: () => clock };
  const queueA = testUploadQueue(apiA.api, {
    ...common,
    createChannel: () => a.channel,
    isVisible: () => visible.a,
    post: postA,
    onUploaded: uploadedA,
  }).queue;
  const queueB = testUploadQueue(apiB.api, {
    ...common,
    createChannel: () => b.channel,
    isVisible: () => visible.b,
    post: postB,
    onUploaded: uploadedB,
    newId: () => `from-b-${++bIds}`,
  }).queue;
  await queueA.start(USER);
  await queueB.start(USER);
  return {
    ...{ locks, store, a, b, visible, apiA, apiB, postA, postB, queueA, queueB },
    ...{ uploadedA, uploadedB },
  };
}

describe("upload queue across windows: takeover (§12.4, FR-UP-5)", () => {
  it("a visible window takes over from a frozen uploading window", async () => {
    const w = await twoWindows({ aHangs: true });
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(w.apiA.uploadUrl).toHaveBeenCalled());
    // A got stuck mid-upload and then froze (Android froze the background tab).
    w.a.member.frozen = true;
    expect(statuses(w.queueB)).toEqual(["uploading"]);

    await wait(TAKEOVER_WAIT);
    await vi.waitFor(() => expect(statuses(w.queueB)).toEqual(["done"]));
    expect(w.apiB.uploadUrl).toHaveBeenCalledOnce();
    // A lost the lock and waits for it again.
    expect(w.locks.waiting).toHaveLength(1);
  });

  it("takes over from a window that runs but doesn't get anywhere", async () => {
    // Found on Android: the background Chrome tab kept its timers (and messages) going while its
    // upload didn't start, so a heartbeat looked fine and the app in front waited for good.
    const w = await twoWindows({ aHangs: true });
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(w.apiA.uploadUrl).toHaveBeenCalled());

    await wait(TAKEOVER_WAIT);
    await vi.waitFor(() => expect(statuses(w.queueB)).toEqual(["done"]));
    expect(w.apiB.uploadUrl).toHaveBeenCalledOnce();
  });

  it("gives the uploading window time to start on newly added work", async () => {
    const w = await twoWindows({ aHangs: true });
    // Long quiet before: nothing to upload, so nobody had progress to report.
    await wait(TAKEOVER_AFTER_MS * 3);
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await wait(TAKEOVER_AFTER_MS - TAKEOVER_CHECK_MS);
    expect(w.apiB.uploadUrl).not.toHaveBeenCalled();
  });

  it("a window in the background never takes over; it does once it's shown", async () => {
    const w = await twoWindows({ aHangs: true, bVisible: false });
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(w.apiA.uploadUrl).toHaveBeenCalled());
    w.a.member.frozen = true;

    await wait(TAKEOVER_AFTER_MS * 3);
    expect(w.apiB.uploadUrl).not.toHaveBeenCalled();

    w.visible.b = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(statuses(w.queueB)).toEqual(["done"]));
  });

  it("doesn't take over when there's nothing to upload", async () => {
    const w = await twoWindows();
    w.a.member.frozen = true;
    await wait(TAKEOVER_AFTER_MS * 3);
    expect(w.locks.waiting).toHaveLength(1);
  });

  it("the window that lost the lock drops its upload, even when its request answers late", async () => {
    const w = await twoWindows({ aHangs: true });
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(w.apiA.uploadUrl).toHaveBeenCalled());
    w.a.member.frozen = true;
    await wait(TAKEOVER_WAIT);
    await vi.waitFor(() => expect(statuses(w.queueB)).toEqual(["done"]));

    // A thaws and its upload-url request finally answers: it must not post the file again.
    w.a.member.frozen = false;
    w.apiA.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.postA).not.toHaveBeenCalled();
    expect(w.postB).toHaveBeenCalledOnce();
  });

  it("counts upload progress as a sign of life", async () => {
    let progress: ((fraction: number) => void) | undefined;
    const w = await twoWindows();
    // A uploads slowly but steadily (a background tab on a desktop): never interrupt that.
    w.postA.mockImplementation((_upload, _file, options) => {
      progress = options?.onProgress;
      return new Promise<void>(() => {});
    });
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(progress).toBeDefined());

    for (let i = 1; i <= 10; i++) {
      progress!(i / 20);
      await wait(TAKEOVER_CHECK_MS);
    }
    expect(w.apiB.uploadUrl).not.toHaveBeenCalled();
  });

  it("the window that lost the lock stops uploading", async () => {
    const w = await twoWindows({ aHangs: true });
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(w.apiA.uploadUrl).toHaveBeenCalled());
    w.a.member.frozen = true;
    await wait(TAKEOVER_WAIT);
    await vi.waitFor(() => expect(statuses(w.queueB)).toEqual(["done"]));

    // A thaws: as a follower it reloads the stored state and uploads nothing more.
    w.a.member.frozen = false;
    await w.queueA.add([testFile("IMG_2.jpg")]);
    await vi.waitFor(() => expect(w.apiB.uploadUrl).toHaveBeenCalledTimes(2));
    expect(w.apiA.uploadUrl).toHaveBeenCalledOnce();
  });
});

describe("upload queue across windows: refresh (§12.4)", () => {
  it("a window that didn't upload refreshes its gallery when another one finishes", async () => {
    const w = await twoWindows();
    // Picked in B (the one on screen), uploaded by A (holding the lock, e.g. a background tab).
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(statuses(w.queueB)).toEqual(["done"]));
    expect(w.apiA.uploadUrl).toHaveBeenCalledOnce();
    expect(w.uploadedA).toHaveBeenCalledOnce();
    expect(w.uploadedB).toHaveBeenCalledOnce();
  });

  it("doesn't refresh again for uploads it already knew were done", async () => {
    const w = await twoWindows();
    await w.queueB.add([testFile("IMG_1.jpg")]);
    await vi.waitFor(() => expect(w.uploadedB).toHaveBeenCalledOnce());
    // Unrelated changes (another file added and removed) reload the list again.
    await w.queueB.add([testFile("IMG_2.jpg", 2000)]);
    await vi.waitFor(() => expect(w.uploadedB).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.uploadedB).toHaveBeenCalledTimes(2);
  });
});
