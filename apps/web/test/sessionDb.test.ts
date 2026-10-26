import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIdbSessionDb, readStoredSession } from "../src/auth/sessionDb";

describe("session database (9.5, §11.4)", () => {
  it("stores, lists and deletes values in IndexedDB, shared by every opener", async () => {
    const factory = new IDBFactory();
    const page = createIdbSessionDb(factory);
    await page.set("user:a", "one");
    const worker = createIdbSessionDb(factory);
    expect(await worker.get("user:a")).toBe("one");
    expect(await worker.keys()).toEqual(["user:a"]);
    await page.delete("user:a");
    expect(await worker.get("user:a")).toBeUndefined();
  });

  it("reads the stored refresh token and sub for the service worker", async () => {
    const db = createIdbSessionDb(new IDBFactory());
    expect(await readStoredSession(db)).toBeNull();
    // Without a refresh token (memory-only session): nothing usable.
    await db.set("user:x", JSON.stringify({ profile: { sub: "user-1" } }));
    expect(await readStoredSession(db)).toBeNull();
    await db.set("user:x", JSON.stringify({ refresh_token: "r", profile: { sub: "user-1" } }));
    expect(await readStoredSession(db)).toEqual({ sub: "user-1", refreshToken: "r" });
  });
});
