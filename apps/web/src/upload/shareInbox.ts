import { done, promisify } from "@/lib/idb";

/** A photo shared to the app (9.6), as kept until the upload page picks it up. */
export interface SharedFile {
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
}

/** A waiting photo with its inbox key, so the page can act on exactly the ones it showed. */
export interface WaitingPhoto {
  id: number;
  file: File;
}

/**
 * Photos shared to the app from Android's share sheet (9.6, FR-PWA-4): the service worker receives
 * them (pwa/shareTarget.ts) before anyone is known to be signed in, so they wait here until the
 * user, on the upload page, confirms them into the signed-in user's queue (after a login if
 * needed) or discards them. Never added without that confirmation: any website can POST to the
 * share target (CSRF), and the service worker can't tell such a POST from the share sheet's.
 * Hence also (9.8): a share replaces what is waiting, so files planted by an earlier POST can't
 * ride along with a real share, and the page takes only the photos it showed.
 */
export interface ShareInbox {
  /** The latest share: whatever was waiting is dropped in the same transaction. */
  replace(files: SharedFile[]): Promise<void>;
  /** Everything waiting, left in place (shown for confirmation). */
  list(): Promise<WaitingPhoto[]>;
  /**
   * The photos with these ids, removed in the same transaction: a second caller gets nothing, and
   * ids a newer share already replaced are skipped (keys are never reused).
   */
  take(ids: number[]): Promise<File[]>;
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
    replace: (files) =>
      write((store) => {
        store.clear();
        files.forEach((file) => store.add(file));
      }),
    async list() {
      const store = (await db()).transaction(STORE).objectStore(STORE);
      const [ids, files] = await Promise.all([
        promisify(store.getAllKeys() as IDBRequest<number[]>),
        promisify(store.getAll() as IDBRequest<SharedFile[]>),
      ]);
      return files.map((file, i) => ({ id: ids[i]!, file: toFile(file) }));
    },
    async take(ids) {
      const tx = (await db()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const found = await Promise.all(
        ids.map((id) => promisify(store.get(id) as IDBRequest<SharedFile | undefined>)),
      );
      ids.forEach((id) => store.delete(id));
      await done(tx);
      return found.filter((file) => file !== undefined).map(toFile);
    },
    clear: () => write((store) => store.clear()),
  };
}
