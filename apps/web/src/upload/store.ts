import type { AllowedContentType } from "@photo-app/shared";

export type UploadStatus = "queued" | "uploading" | "done" | "failed";

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

const promisify = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

/**
 * The queue in IndexedDB (FR-UP-5): files survive reloads, app restarts and connection loss.
 * Its own database, so other stores (the Query cache, 9.3) can version theirs independently.
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

  async function write(change: (store: IDBObjectStore) => void) {
    const tx = (await db()).transaction(STORE, "readwrite");
    change(tx.objectStore(STORE));
    await done(tx);
  }

  return {
    async list(userId) {
      const tx = (await db()).transaction(STORE);
      const items = await promisify(
        tx.objectStore(STORE).index("userId").getAll(userId) as IDBRequest<UploadItem[]>,
      );
      return items.sort((a, b) => a.addedAt - b.addedAt);
    },
    put: (item) => write((store) => store.put(item)),
    delete: (id) => write((store) => store.delete(id)),
    clear: () => write((store) => store.clear()),
  };
}
