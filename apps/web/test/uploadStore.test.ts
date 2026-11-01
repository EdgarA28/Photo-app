import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
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

  describe("bytes in a record of their own (13.1-0)", () => {
    // A stand-in that survives the structured clone (see above); the store only passes it on.
    const bytes = (n: number) => ({ bytes: n }) as unknown as Blob;
    const filePuts = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([value]) => String((value as { id: string }).id).endsWith("#file"))
        .length;

    it("writes the bytes once; status changes rewrite only the item", async () => {
      const factory = new IDBFactory();
      const store = createIdbStore(factory);
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const file = bytes(1);

      await store.put(item("a", { file }));
      await store.put(item("a", { file, status: "uploading" }));
      await store.put(item("a", { file, status: "uploading", photoId: "p1" }));
      expect(filePuts(put)).toBe(1);

      const reopened = createIdbStore(factory);
      const [read] = await reopened.list(testUser.sub);
      expect(read).toMatchObject({ status: "uploading", photoId: "p1", file: { bytes: 1 } });
      // Read back, so not written again by the next status change either.
      await reopened.put({ ...read!, status: "queued" });
      expect(filePuts(put)).toBe(1);
      put.mockRestore();
    });

    it("drops the bytes once the upload is done", async () => {
      const factory = new IDBFactory();
      const store = createIdbStore(factory);
      await store.put(item("a", { file: bytes(1) }));
      await store.put(item("a", { status: "done", file: null }));
      expect((await createIdbStore(factory).list(testUser.sub))[0]!.file).toBeNull();
    });

    it("deletes an item with its bytes", async () => {
      const factory = new IDBFactory();
      const store = createIdbStore(factory);
      await store.put(item("a", { file: bytes(1) }));
      await store.delete("a");
      await store.put(item("a"));
      expect((await createIdbStore(factory).list(testUser.sub))[0]!.file).toBeNull();
    });

    it("reads items stored with their bytes inline (before 13.1-0)", async () => {
      const factory = new IDBFactory();
      const store = createIdbStore(factory);
      await store.list(testUser.sub); // creates the database
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = factory.open("photo-app-uploads", 1);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction("uploads", "readwrite");
        tx.objectStore("uploads").put(item("old", { file: bytes(7) }));
        tx.oncomplete = () => resolve();
      });
      db.close();

      expect((await store.list(testUser.sub))[0]!.file).toEqual({ bytes: 7 });
    });
  });
});
