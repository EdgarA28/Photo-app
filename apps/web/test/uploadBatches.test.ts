import type { UploadUrlRequest } from "@photo-app/shared";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/api";
import type { PostToS3 } from "../src/upload/s3Post";
import {
  BATCH_SAVE_MS,
  createIdbBatchStore,
  fileKey,
  folderLabel,
  INTERRUPTED_AFTER_MS,
  type BatchRecord,
} from "../src/upload/batches";
import {
  controlledPost,
  MemoryBatchStore,
  testFile,
  testId,
  testUploadQueue,
  testUser,
} from "./fakes";

// 13.1f: a large batch is remembered, so after its tab was closed the rest can be uploaded by
// picking the same folder again, without the photos already uploaded.

const USER = testUser.sub;
const UPLOAD = { url: "https://photos.s3.amazonaws.com/", fields: { key: "k" } };
/** Two 1,000-byte files make a large batch with this threshold. */
const LARGE = 1500;

function uploadApi() {
  let n = 0;
  const uploadUrl = vi.fn(async (body: UploadUrlRequest) => ({
    photoId: body.photoId ?? testId(++n),
    upload: UPLOAD,
  }));
  return { api: { photos: { uploadUrl } } as unknown as Pick<Api, "photos">, uploadUrl };
}

let clock: number;
beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => vi.useRealTimers());

/** Moves the queue's clock and its intervals (the batch saving) forward. */
async function wait(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

function queueWith(batches: MemoryBatchStore, post: PostToS3 = controlledPost().post) {
  const { api, uploadUrl } = uploadApi();
  const { queue } = testUploadQueue(api, {
    post,
    batches,
    largeBatchBytes: LARGE,
    now: () => clock,
    refreshEveryMs: 0,
    // A channel, so the queue runs its timers as in the app.
    createChannel: () => new BroadcastChannel(`test-${Math.random()}`),
  });
  return { queue, uploadUrl };
}

const files = (...names: string[]) => names.map((name) => testFile(name));

describe("remembered large batches (13.1f)", () => {
  it("remembers a large batch, what got uploaded, and forgets it when it's done", async () => {
    const batches = new MemoryBatchStore();
    const s3 = controlledPost();
    const { queue } = queueWith(batches, s3.post);
    await queue.start(USER);
    const picked = files("A.jpg", "B.jpg", "C.jpg");
    await queue.add(picked, { folder: true, label: "Trip" });

    const [record] = [...batches.records.values()];
    expect(record).toMatchObject({ userId: USER, label: "Trip", done: [] });
    expect(record!.keys).toEqual(picked.map(fileKey));

    await vi.waitFor(() => expect(s3.calls).toHaveLength(3));
    s3.calls[0]!.resolve();
    await vi.waitFor(() => expect(queue.getSnapshot()[0]!.status).toBe("done"));
    await wait(BATCH_SAVE_MS);
    expect([...batches.records.values()][0]!.done).toEqual([fileKey(picked[0]!)]);

    s3.calls[1]!.resolve();
    s3.calls[2]!.resolve();
    await vi.waitFor(() =>
      expect(queue.getSnapshot().every((e) => e.status === "done")).toBe(true),
    );
    await wait(BATCH_SAVE_MS);
    expect(batches.records.size).toBe(0);
    queue.stop();
  });

  it("shows a batch whose tab went quiet as interrupted, with what is left", async () => {
    const batches = new MemoryBatchStore();
    const { queue } = queueWith(batches);
    await queue.start(USER);
    const old: BatchRecord = {
      batchId: "b1",
      userId: USER,
      label: "Trip",
      createdAt: clock - 60 * 60_000,
      heartbeatAt: clock - INTERRUPTED_AFTER_MS - 1,
      keys: ["a", "b", "c", "d"],
      done: ["a"],
    };
    await batches.put(old);
    await batches.put({ ...old, batchId: "live", heartbeatAt: clock - 1000 });
    await batches.put({ ...old, batchId: "other", userId: "someone-else" });

    expect(await queue.interruptedBatches()).toEqual([
      { batchId: "b1", label: "Trip", total: 4, remaining: 3 },
    ]);
    await queue.dismissBatch("b1");
    expect(await queue.interruptedBatches()).toEqual([]);
    queue.stop();
  });

  it("picked again, uploads only the rest and goes on with the same batch", async () => {
    const batches = new MemoryBatchStore();
    const picked = files("A.jpg", "B.jpg", "C.jpg");
    await batches.put({
      batchId: "b1",
      userId: USER,
      label: "Trip",
      createdAt: 0,
      heartbeatAt: clock - INTERRUPTED_AFTER_MS - 1,
      keys: picked.map(fileKey),
      done: [fileKey(picked[0]!), fileKey(picked[1]!)],
    });
    const { queue, uploadUrl } = queueWith(batches, async () => {});
    await queue.start(USER);

    const result = await queue.add(picked, { folder: true, label: "Trip" });
    expect(result).toMatchObject({ added: 1, alreadyUploaded: 2 });
    expect(queue.getSnapshot().map((e) => e.fileName)).toEqual(["C.jpg"]);
    // Running again: not offered as interrupted.
    expect(await queue.interruptedBatches()).toEqual([]);
    await vi.waitFor(() => expect(uploadUrl).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queue.getSnapshot()[0]!.status).toBe("done"));
    await wait(BATCH_SAVE_MS);
    expect(batches.records.size).toBe(0);
    queue.stop();
  });

  it("after Cancel all there's nothing to go on with", async () => {
    const batches = new MemoryBatchStore();
    const { queue } = queueWith(batches);
    await queue.start(USER);
    await queue.add(files("A.jpg", "B.jpg"));
    expect(batches.records.size).toBe(1);
    await queue.cancelAll();
    expect(batches.records.size).toBe(0);
    queue.stop();
  });

  it("logging out forgets the remembered batches (file names are personal)", async () => {
    const batches = new MemoryBatchStore();
    const { queue } = queueWith(batches);
    await queue.start(USER);
    await queue.add(files("A.jpg", "B.jpg"));
    queue.stop();
    await queue.clear();
    expect(batches.records.size).toBe(0);
  });

  it("small picks aren't remembered: they are stored in full anyway", async () => {
    const batches = new MemoryBatchStore();
    const { queue } = queueWith(batches);
    await queue.start(USER);
    await queue.add(files("A.jpg"));
    expect(batches.records.size).toBe(0);
    queue.stop();
  });
});

describe("batch helpers (13.1f)", () => {
  it("keys files by name, size and last change", () => {
    const a = new File([new Uint8Array(10)], "a.jpg", { lastModified: 1 });
    const same = new File([new Uint8Array(10)], "a.jpg", { lastModified: 1 });
    const changed = new File([new Uint8Array(10)], "a.jpg", { lastModified: 2 });
    expect(fileKey(a)).toBe(fileKey(same));
    expect(fileKey(a)).not.toBe(fileKey(changed));
  });

  it("names a folder pick after its folder", () => {
    const file = testFile("a.jpg");
    Object.defineProperty(file, "webkitRelativePath", { value: "Trip 2024/day1/a.jpg" });
    expect(folderLabel([file])).toBe("Trip 2024");
    expect(folderLabel([testFile("a.jpg")])).toBeNull();
  });

  it("keeps records per user in IndexedDB", async () => {
    vi.useRealTimers();
    const store = createIdbBatchStore(new IDBFactory());
    const record: BatchRecord = {
      batchId: "b1",
      userId: USER,
      label: null,
      createdAt: 1,
      heartbeatAt: 2,
      keys: ["a"],
      done: [],
    };
    await store.put(record);
    await store.put({ ...record, batchId: "b2", userId: "someone-else" });
    expect(await store.list(USER)).toEqual([record]);
    await store.delete("b1");
    expect(await store.list(USER)).toEqual([]);
    await store.clear();
    expect(await store.list("someone-else")).toEqual([]);
  });
});
