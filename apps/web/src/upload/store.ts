import type { AllowedContentType } from "@photo-app/shared";
import type { ClientErrorCode } from "@/api/errors";
import { done, promisify } from "@/lib/idb";

export type UploadStatus = "queued" | "uploading" | "done" | "failed";

/** Why an upload failed for good: an API error code, or what went wrong outside the API. */
export type UploadErrorCode = ClientErrorCode | "S3_REJECTED" | "FILE_MISSING" | "UNKNOWN";

/** One selected file in the upload queue (§12.4), as kept in IndexedDB. */
export interface UploadItem {
  /** Local ID; the server's `photoId` only exists after the first upload-url request. */
  id: string;
  /** Cognito `sub` of the user who queued it: another account on the device never uploads it. */
  userId: string;
  /** The bytes, until uploaded; then dropped, as they are in S3. */
  file: Blob | null;
  fileName: string;
  contentType: AllowedContentType;
  sizeBytes: number;
  /** Set by the first upload-url response and sent on every retry (5.6a), so no duplicates. */
  photoId: string | null;
  status: UploadStatus;
  /** Failed attempts so far, for the backoff. */
  attempts: number;
  /** Earliest time (ms) for the next attempt after a temporary failure; 0 = now. */
  retryAt: number;
  /** User-facing reason of a permanent failure. */
  error: string | null;
  /** Its code, so the UI can group failures (e.g. storage full, 8.14). */
  errorCode: UploadErrorCode | null;
  addedAt: number;
}

/** Persistence of the queue; IndexedDB in the app, in memory in tests. */
export interface UploadStore {
  list(userId: string): Promise<UploadItem[]>;
  put(item: UploadItem): Promise<void>;
  delete(id: string): Promise<void>;
  /** Everything, every user (logout, 8.13). */
  clear(): Promise<void>;
}

const DB_NAME = "photo-app-uploads";
const STORE = "uploads";

/** Key of an item's bytes, a record of its own next to the item (no `userId`, so not indexed). */
const fileKey = (id: string) => `${id}#file`;

/** The item's record: everything but the bytes. */
type StoredMeta = Omit<UploadItem, "file"> & { file?: Blob | null };

/**
 * The queue in IndexedDB (FR-UP-5): files survive reloads, app restarts and connection loss.
 * Its own database, so other stores (the Query cache, 9.3) can version theirs independently.
 *
 * The bytes sit in a record of their own (`{id}#file`), written once: a status change rewrites
 * only the small item record, not up to 50 MB again (13.1-0). Items stored before that keep their
 * bytes inline and are read as before; their next write moves them.
 */
export function createIdbStore(factory: IDBFactory = indexedDB): UploadStore {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () => {
    opened ??= (() => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("userId", "userId");
      };
      return promisify(request);
    })();
    return opened;
  };
  /** The bytes this instance last wrote or read per item: unchanged ones aren't written again. */
  const storedFiles = new Map<string, Blob | null>();

  async function write(change: (store: IDBObjectStore) => void) {
    const tx = (await db()).transaction(STORE, "readwrite");
    change(tx.objectStore(STORE));
    await done(tx);
  }

  return {
    async list(userId) {
      const tx = (await db()).transaction(STORE);
      const store = tx.objectStore(STORE);
      const items: UploadItem[] = [];
      // Each item's bytes are read in the same transaction, requested in the callback while it
      // is still active.
      const request = store.index("userId").getAll(userId) as IDBRequest<StoredMeta[]>;
      request.onsuccess = () => {
        for (const meta of request.result) {
          const file = store.get(fileKey(meta.id)) as IDBRequest<{ file: Blob } | undefined>;
          file.onsuccess = () => {
            const bytes = file.result?.file ?? meta.file ?? null;
            if (file.result) storedFiles.set(meta.id, bytes);
            // Items stored before 8.14 have no errorCode.
            items.push({ ...meta, file: bytes, errorCode: meta.errorCode ?? null });
          };
        }
      };
      await done(tx);
      return items.sort((a, b) => a.addedAt - b.addedAt);
    },
    async put(item) {
      const { file, ...meta } = item;
      const fileChanged = !storedFiles.has(item.id) || storedFiles.get(item.id) !== file;
      await write((store) => {
        store.put(meta);
        if (!fileChanged) return;
        if (file) store.put({ id: fileKey(item.id), file });
        else store.delete(fileKey(item.id));
      });
      storedFiles.set(item.id, file);
    },
    async delete(id) {
      await write((store) => {
        store.delete(id);
        store.delete(fileKey(id));
      });
      storedFiles.delete(id);
    },
    async clear() {
      await write((store) => store.clear());
      storedFiles.clear();
    },
  };
}
