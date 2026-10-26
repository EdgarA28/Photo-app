import { done, promisify } from "@/lib/idb";

/** A photo shared to the app (9.6), as kept until the upload page picks it up. */
export interface SharedFile {
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
}

/**
 * Photos shared to the app from Android's share sheet (9.6, FR-PWA-4): the service worker receives
 * them (pwa/shareTarget.ts) before anyone is known to be signed in, so they wait here until the
 * user, on the upload page, confirms them into the signed-in user's queue (after a login if
 * needed) or discards them. Never added without that confirmation: any website can POST to the
 * share target (CSRF), and the service worker can't tell such a POST from the share sheet's.
 */
export interface ShareInbox {
  put(files: SharedFile[]): Promise<void>;
  /** Everything waiting, left in place (shown for confirmation). */
  list(): Promise<File[]>;
  /** Everything waiting, removed in the same transaction: a second caller gets nothing. */
  take(): Promise<File[]>;
  /** Logout (FR-AUTH-5): shared photos not yet added mustn't wait for the next account. */
  clear(): Promise<void>;
}

const DB_NAME = "photo-app-share-inbox";
const STORE = "files";

/** Its own database, like the upload queue's: page and service worker both open it. */
export function createIdbShareInbox(factory: IDBFactory = indexedDB): ShareInbox {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () => {
    opened ??= (() => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE, { autoIncrement: true });
      return promisify(request);
    })();
    return opened;
  };

  async function write(change: (store: IDBObjectStore) => void) {
    const tx = (await db()).transaction(STORE, "readwrite");
    change(tx.objectStore(STORE));
    await done(tx);
  }

  const toFile = ({ name, type, lastModified, blob }: SharedFile) =>
    new File([blob], name, { type, lastModified });

  return {
    put: (files) => write((store) => files.forEach((file) => store.add(file))),
    async list() {
      const tx = (await db()).transaction(STORE);
      return (await promisify(tx.objectStore(STORE).getAll() as IDBRequest<SharedFile[]>)).map(
        toFile,
      );
    },
    async take() {
      const tx = (await db()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const files = await promisify(store.getAll() as IDBRequest<SharedFile[]>);
      store.clear();
      await done(tx);
      return files.map(toFile);
    },
    clear: () => write((store) => store.clear()),
  };
}
