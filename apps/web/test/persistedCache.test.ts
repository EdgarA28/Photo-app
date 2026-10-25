import { QueryClient } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdbKeyValue,
  createPersistedQueryCache,
  PERSIST_MAX_AGE_MS,
  QUERY_GC_TIME_MS,
  type KeyValueStorage,
} from "../src/queries/persistedCache";
import { createQueryClient } from "../src/router";
import { testUser } from "./fakes";

const KEY = "query-client";
const otherUser = "04e8b4b8-0000-4000-8000-000000000002";

/** One "device": a fresh IndexedDB shared by every app start in the test. */
function device() {
  const storage = createIdbKeyValue(new IDBFactory());
  /** An app start: new Query client, new persisted cache on the same storage. */
  const start = () => {
    const queryClient = createQueryClient();
    const cache = createPersistedQueryCache(queryClient, { storage, throttleTime: 0 });
    return { queryClient, cache };
  };
  return { storage, start };
}

/** Waits until a save holding at least one query has reached storage (saves are async). */
const saved = (storage: KeyValueStorage) =>
  vi.waitFor(async () => {
    const value = JSON.parse((await storage.getItem(KEY)) ?? "null") as {
      timestamp: number;
      clientState: { queries: unknown[] };
    } | null;
    if (!value?.clientState.queries.length) throw new Error("not saved yet");
    return value;
  });

afterEach(() => vi.restoreAllMocks());

describe("persisted Query cache (9.3, FR-PWA-2)", () => {
  it("restores the last data for the same user after a restart", async () => {
    const { storage, start } = device();
    const first = start();
    await first.cache.start(testUser.sub);
    first.queryClient.setQueryData(["albums"], { items: [{ name: "Holidays" }] });
    await saved(storage);

    const second = start();
    await second.cache.start(testUser.sub);
    expect(second.queryClient.getQueryData(["albums"])).toEqual({
      items: [{ name: "Holidays" }],
    });
  });

  it("never gives one user's saved data to another and deletes it", async () => {
    const { storage, start } = device();
    const first = start();
    await first.cache.start(testUser.sub);
    first.queryClient.setQueryData(["albums"], { items: [{ name: "Private" }] });
    await saved(storage);

    const second = start();
    await second.cache.start(otherUser);
    expect(second.queryClient.getQueryData(["albums"])).toBeUndefined();
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("drops a saved cache older than 30 days", async () => {
    const { storage, start } = device();
    const first = start();
    await first.cache.start(testUser.sub);
    first.queryClient.setQueryData(["albums"], { items: [] });
    const value = await saved(storage);
    await storage.setItem(
      KEY,
      JSON.stringify({ ...value, timestamp: Date.now() - PERSIST_MAX_AGE_MS - 1000 }),
    );

    const second = start();
    await second.cache.start(testUser.sub);
    expect(second.queryClient.getQueryData(["albums"])).toBeUndefined();
  });

  it("keeps unused data for a day, within the browser's timer limit (gcTime)", async () => {
    const queryClient = createQueryClient();
    expect(queryClient.getDefaultOptions().queries?.gcTime).toBe(QUERY_GC_TIME_MS);
    expect(QUERY_GC_TIME_MS).toBeLessThanOrEqual(2 ** 31 - 1);
    // An unobserved query must survive (a gcTime over the limit removed it at once).
    queryClient.setQueryData(["albums"], { items: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryClient.getQueryData(["albums"])).toEqual({ items: [] });
  });

  it("restores once per user, however many navigations ask", async () => {
    const { storage } = device();
    const getItem = vi.spyOn(storage, "getItem");
    const cache = createPersistedQueryCache(new QueryClient(), { storage });
    await Promise.all([cache.start(testUser.sub), cache.start(testUser.sub)]);
    await cache.start(testUser.sub);
    expect(getItem).toHaveBeenCalledOnce();
  });

  it("clear() deletes the saved cache, and a save still in flight doesn't bring it back", async () => {
    const { storage } = device();
    const queryClient = createQueryClient();
    // A slow save: still pending when the user logs out.
    const cache = createPersistedQueryCache(queryClient, { storage, throttleTime: 50 });
    await cache.start(testUser.sub);
    queryClient.setQueryData(["albums"], { items: [] });

    await cache.clear();
    queryClient.clear();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("stays cleared: a start during logout neither restores nor saves", async () => {
    const { storage } = device();
    const queryClient = createQueryClient();
    const cache = createPersistedQueryCache(queryClient, { storage, throttleTime: 0 });
    await cache.start(testUser.sub);
    await cache.clear();

    // E.g. the guard runs again while auth.logout is still revoking the token.
    await cache.start(testUser.sub);
    queryClient.setQueryData(["albums"], { items: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("works without saving when IndexedDB can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: KeyValueStorage = {
      getItem: () => Promise.reject(new DOMException("blocked", "UnknownError")),
      setItem: () => Promise.reject(new DOMException("blocked", "UnknownError")),
      removeItem: () => Promise.reject(new DOMException("blocked", "UnknownError")),
    };
    const cache = createPersistedQueryCache(createQueryClient(), { storage: broken });
    await expect(cache.start(testUser.sub)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
