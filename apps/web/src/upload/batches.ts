import { done, promisify } from "@/lib/idb";

/**
 * What is remembered of a large batch (13.1f) so it can be continued after the tab that ran it was
 * closed or reloaded: which files it had and which of them are uploaded, by `fileKey`. No bytes:
 * a large batch's files are read from the disk (13.1c), so continuing means picking them again.
 */
export interface BatchRecord {
  batchId: string;
  /** Cognito `sub`: another account on the device never sees it. */
  userId: string;
  /** The folder's name, or null for a pick of files. */
  label: string | null;
  createdAt: number;
  /** Last sign of life from the tab running it; quiet for `INTERRUPTED_AFTER_MS` = interrupted. */
  heartbeatAt: number;
  keys: string[];
  done: string[];
}

/** A batch no tab is running any more, with what is left of it. */
export interface InterruptedBatch {
  batchId: string;
  label: string | null;
  total: number;
  remaining: number;
}

/** Remembered batches; IndexedDB in the app, in memory in tests. */
export interface BatchStore {
  list(userId: string): Promise<BatchRecord[]>;
  put(record: BatchRecord): Promise<void>;
  delete(batchId: string): Promise<void>;
  /** Everything, every user (logout, 8.13: file names are personal). */
  clear(): Promise<void>;
}

/** How often the running tab updates its batch records. */
export const BATCH_SAVE_MS = 5000;
/** A batch not updated for this long is no longer running anywhere (its tab is gone). */
export const INTERRUPTED_AFTER_MS = 30_000;

/**
 * Identifies a picked file across picks: name, size and last change. Picking the same folder
 * again gives the same keys, so uploaded files can be skipped; a file changed since gets a new
 * key and is uploaded again.
 */
export const fileKey = (file: Pick<File, "name" | "size" | "lastModified">) =>
  `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

/** The folder a folder pick came from: the first part of its files' relative paths. */
export function folderLabel(files: readonly File[]): string | null {
  const path = (files[0] as (File & { webkitRelativePath?: string }) | undefined)
    ?.webkitRelativePath;
  return path?.includes("/") ? path.split("/")[0]! : null;
}

const DB_NAME = "photo-app-batches";
const STORE = "batches";

/** The records in IndexedDB, in a database of their own (no version bump of the upload queue). */
export function createIdbBatchStore(factory: IDBFactory = indexedDB): BatchStore {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () => {
    opened ??= (() => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore(STORE, { keyPath: "batchId" })
          .createIndex("userId", "userId");
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
      return promisify(
        tx.objectStore(STORE).index("userId").getAll(userId) as IDBRequest<BatchRecord[]>,
      );
    },
    put: (record) => write((store) => store.put(record)),
    delete: (batchId) => write((store) => store.delete(batchId)),
    clear: () => write((store) => store.clear()),
  };
}
