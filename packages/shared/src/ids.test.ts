import { decodeTime } from "ulid";
import { describe, expect, test } from "vitest";
import { isId, isUserId, newId } from "./ids";

describe("newId", () => {
  test("produces valid, unique, sortable IDs", () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    expect(ids.every(isId)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  test("encodes the creation time", () => {
    const before = Date.now();
    const time = decodeTime(newId());
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });
});

describe("validators", () => {
  test("isId", () => {
    expect(isId("01JABCDEFGHJKMNPQRSTVWXYZ0")).toBe(true);
    expect(isId("01jabcdefghjkmnpqrstvwxyz0")).toBe(false);
    expect(isId("01JABCDEFGHJKMNPQRSTVWXYZ")).toBe(false);
    expect(isId("01JABCDEFGHJKMNPQRSTVWXYZU")).toBe(false);
  });

  test("isUserId", () => {
    expect(isUserId("3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f")).toBe(true);
    expect(isUserId("3F1C2B4A-9D8E-4F7A-B6C5-1A2B3C4D5E6F")).toBe(false);
    expect(isUserId("3f1c2b4a9d8e4f7ab6c51a2b3c4d5e6f")).toBe(false);
  });
});
