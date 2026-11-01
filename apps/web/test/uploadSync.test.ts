import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/api";
import { SYNC_REARM_MS } from "../src/upload/queue";
import { testFile, testUploadQueue, testUser } from "./fakes";

// 9.5: a hidden page with uploads waiting asks for Background Sync, so the service worker uploads
// if the app is closed or frozen next (pwa/backgroundUploads.ts).

let visible: boolean;
let registerSync: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  visible = true;
  registerSync = vi.fn<() => Promise<void>>(async () => {});
});
afterEach(() => vi.useRealTimers());

function hide(hidden = true) {
  visible = !hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A queue whose uploads never get an upload URL, so they stay waiting. */
async function startQueue(largeBatchBytes?: number) {
  const uploadUrl = vi.fn(() => new Promise(() => {}));
  const api = { photos: { uploadUrl } } as unknown as Pick<Api, "photos">;
  const { queue } = testUploadQueue(api, {
    isVisible: () => visible,
    registerSync,
    ...(largeBatchBytes !== undefined && { largeBatchBytes }),
  });
  await queue.start(testUser.sub);
  return queue;
}

describe("Background Sync request (9.5)", () => {
  it("asks for it when hidden with uploads waiting, and again every minute", async () => {
    const queue = await startQueue();
    await queue.add([testFile("IMG_1.jpg")]);
    expect(registerSync).not.toHaveBeenCalled();

    hide();
    expect(registerSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SYNC_REARM_MS);
    expect(registerSync).toHaveBeenCalledTimes(2);

    // Shown again: this page uploads itself.
    hide(false);
    await vi.advanceTimersByTimeAsync(SYNC_REARM_MS * 3);
    expect(registerSync).toHaveBeenCalledTimes(2);
    queue.stop();
  });

  it("doesn't ask without waiting uploads, or after stop", async () => {
    const queue = await startQueue();
    hide();
    expect(registerSync).not.toHaveBeenCalled();
    hide(false);

    await queue.add([testFile("IMG_1.jpg")]);
    queue.stop();
    hide();
    await vi.advanceTimersByTimeAsync(SYNC_REARM_MS);
    expect(registerSync).not.toHaveBeenCalled();
  });

  it("ignores a browser without Background Sync", async () => {
    registerSync.mockRejectedValue(new Error("not supported"));
    const queue = await startQueue();
    await queue.add([testFile("IMG_1.jpg")]);
    hide();
    await vi.advanceTimersByTimeAsync(0);
    expect(registerSync).toHaveBeenCalled();
    queue.stop();
  });

  it("doesn't ask for a large batch: the service worker can't read it (13.1c)", async () => {
    const queue = await startQueue(1500);
    await queue.add([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);
    expect(queue.getSnapshot().every((entry) => entry.memoryOnly)).toBe(true);
    hide();
    await vi.advanceTimersByTimeAsync(SYNC_REARM_MS);
    expect(registerSync).not.toHaveBeenCalled();
    queue.stop();
  });
});
