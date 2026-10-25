import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIdbStore, type UploadItem } from "../src/upload/store";
import { testUser } from "./fakes";

// jsdom's Blob doesn't survive fake-indexeddb's structured clone, so these items carry no file;
// the queue's own tests use an in-memory store.
const item = (id: string, overrides: Partial<UploadItem> = {}): UploadItem => ({
  id,
  userId: testUser.sub,
  file: null,
  fileName: `${id}.jpg`,
  contentType: "image/jpeg",
  sizeBytes: 1000,
  photoId: null,
  status: "queued",
  attempts: 0,
  retryAt: 0,
  error: null,
  errorCode: null,
  addedAt: 0,
  ...overrides,
});

describe("IndexedDB upload store (FR-UP-5)", () => {
  it("keeps items across store instances (a reload), per user, in the order added", async () => {
    const factory = new IDBFactory();
    const store = createIdbStore(factory);
    await store.put(item("b", { addedAt: 2 }));
    await store.put(item("a", { addedAt: 1 }));
    await store.put(item("other", { userId: "someone-else" }));

    const reopened = createIdbStore(factory);
    expect((await reopened.list(testUser.sub)).map((i) => i.id)).toEqual(["a", "b"]);
    expect((await reopened.list("someone-else")).map((i) => i.id)).toEqual(["other"]);
  });

  it("reads items stored before error codes existed (8.14)", async () => {
    const store = createIdbStore(new IDBFactory());
    const { errorCode: _, ...old } = item("old", { status: "failed", error: "Failed" });
    await store.put(old as UploadItem);
    expect((await store.list(testUser.sub))[0]).toMatchObject({ error: "Failed", errorCode: null });
  });

  it("updates, deletes and clears", async () => {
    const store = createIdbStore(new IDBFactory());
    await store.put(item("a"));
    await store.put(item("b"));
    await store.put(item("a", { status: "done", photoId: "01JB2Z3M4N5P6Q7R8S9T000001" }));
    await store.delete("b");
    expect(await store.list(testUser.sub)).toEqual([
      item("a", { status: "done", photoId: "01JB2Z3M4N5P6Q7R8S9T000001" }),
    ]);

    await store.clear();
    expect(await store.list(testUser.sub)).toEqual([]);
  });
});
