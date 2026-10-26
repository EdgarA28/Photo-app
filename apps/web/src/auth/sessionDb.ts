import { done, promisify } from "@/lib/idb";

/**
 * Where the persisted part of the session lives: the refresh token and `sub` (spec §11.4, as
 * changed for 9.5). IndexedDB rather than localStorage, because the service worker reads it to
 * upload in the background and has no localStorage. Same exposure: both are readable by any
 * script on the origin and by nothing else. Values are the JSON strings `SessionStore` writes.
 */
export interface SessionDb {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const DB_NAME = "photo-app-session";
const STORE = "session";

/** Its own database, like the upload queue's and the Query cache's. */
export function createIdbSessionDb(factory: IDBFactory = indexedDB): SessionDb {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () => {
    opened ??= (() => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      return promisify(request);
    })();
    return opened;
  };

  async function read<T>(query: (store: IDBObjectStore) => IDBRequest<T>) {
    return promisify(query((await db()).transaction(STORE).objectStore(STORE)));
  }

  async function write(change: (store: IDBObjectStore) => void) {
    const tx = (await db()).transaction(STORE, "readwrite");
    change(tx.objectStore(STORE));
    await done(tx);
  }

  return {
    get: (key) => read((store) => store.get(key) as IDBRequest<string | undefined>),
    set: (key, value) => write((store) => store.put(value, key)),
    delete: (key) => write((store) => store.delete(key)),
    keys: async () => (await read((store) => store.getAllKeys())).map(String),
  };
}

/** What the service worker needs to act for the signed-in user. */
export interface StoredSession {
  sub: string;
  refreshToken: string;
}

/**
 * The stored session, as `SessionStore` wrote it (oidc-client-ts keeps one user per app client, so
 * there is at most one). Null without a login.
 */
export async function readStoredSession(db: SessionDb): Promise<StoredSession | null> {
  for (const key of await db.keys()) {
    const value = await db.get(key);
    if (!value) continue;
    const { refresh_token, profile } = JSON.parse(value) as {
      refresh_token?: unknown;
      profile?: { sub?: unknown };
    };
    if (typeof refresh_token === "string" && typeof profile?.sub === "string") {
      return { sub: profile.sub, refreshToken: refresh_token };
    }
  }
  return null;
}
