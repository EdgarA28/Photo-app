import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/query-persist-client-core";
import type { QueryClient } from "@tanstack/react-query";

/**
 * How long a saved cache stays usable (FR-PWA-2): as long as a session can last without the app
 * being opened (Cognito refresh token, 30 days) and as long as the cached thumbnails (9.2).
 */
export const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Query's `gcTime` (how long unused data stays in memory, and so in the next save). The default 5
 * minutes would drop a page's data from the saved cache soon after leaving it. Not the 30 days of
 * the saved cache: Query uses a timer, and anything over 2^31 - 1 ms (~24.8 days) fires at once,
 * deleting every unused query immediately. A day also prunes restored data nobody looks at.
 */
export const QUERY_GC_TIME_MS = 24 * 60 * 60 * 1000;

/** Bump when cached API data changes shape, so an old saved cache isn't fed to new code. */
const CACHE_VERSION = 1;

const DB_NAME = "photo-app-query-cache";
const STORE = "kv";
const KEY = "query-client";

/** The Query cache on disk (9.3, FR-PWA-2, §12.2): the app opens offline with the last data. */
export interface PersistedQueryCache {
  /**
   * Loads the cache saved for `userId` into the client, then keeps saving it (throttled). Another
   * user's or an expired saved cache is discarded instead. Once per session; never throws.
   */
  start(userId: string): Promise<void>;
  /**
   * Stops saving and deletes the saved cache when the session ends (logout, FR-AUTH-5, or a
   * rejected session). Final for this page: `start()` does nothing afterwards, so a navigation
   * during logout can't resume saving. Logout and login both end with a full-page navigation, so
   * the next session gets a fresh page.
   */
  clear(): Promise<void>;
}

/** String key-value storage for the persister; IndexedDB in the app (fake-indexeddb in tests). */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const promisify = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Its own database, so it versions apart from the upload queue (8.10). */
export function createIdbKeyValue(factory: IDBFactory = indexedDB): KeyValueStorage {
  let opened: Promise<IDBDatabase> | undefined;
  const store = async (mode: IDBTransactionMode) => {
    opened ??= (() => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      return promisify(request);
    })();
    return (await opened).transaction(STORE, mode).objectStore(STORE);
  };
  return {
    async getItem(key) {
      return ((await promisify((await store("readonly")).get(key))) as string | undefined) ?? null;
    },
    async setItem(key, value) {
      await promisify((await store("readwrite")).put(value, key));
    },
    async removeItem(key) {
      await promisify((await store("readwrite")).delete(key));
    },
  };
}

export function createPersistedQueryCache(
  queryClient: QueryClient,
  {
    storage = createIdbKeyValue(),
    // At most one write per second, however often the cache changes (polling, scrolling).
    throttleTime = 1000,
  }: { storage?: KeyValueStorage; throttleTime?: number } = {},
): PersistedQueryCache {
  // A save the persister throttled can still arrive after `clear()`; it must not bring the
  // deleted data back, so writes are dropped while stopped.
  let saving = false;
  const persister = createAsyncStoragePersister({
    key: KEY,
    throttleTime,
    storage: {
      getItem: (key) => storage.getItem(key),
      setItem: async (key, value: string) => {
        if (saving) await storage.setItem(key, value);
      },
      removeItem: (key) => storage.removeItem(key),
    },
  });
  let started: { userId: string; done: Promise<void> } | null = null;
  let closed = false;
  let unsubscribe: (() => void) | null = null;

  return {
    start(userId) {
      if (closed) return Promise.resolve();
      if (started?.userId === userId) return started.done;
      unsubscribe?.();
      // The saved cache is tagged with its user: restoring it for anyone else discards it.
      const buster = `${CACHE_VERSION}:${userId}`;
      const done = (async () => {
        try {
          await persistQueryClientRestore({
            queryClient,
            persister,
            buster,
            maxAge: PERSIST_MAX_AGE_MS,
          });
        } catch (error) {
          // Can't read IndexedDB (blocked, private mode): the app works, just not offline.
          console.warn("Restoring the saved query cache failed", error);
        }
        saving = true;
        unsubscribe = persistQueryClientSubscribe({ queryClient, persister, buster });
      })();
      started = { userId, done };
      return done;
    },

    async clear() {
      closed = true;
      saving = false;
      unsubscribe?.();
      unsubscribe = null;
      started = null;
      await persister.removeClient();
    },
  };
}
