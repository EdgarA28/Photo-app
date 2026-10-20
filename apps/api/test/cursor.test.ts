import { describe, expect, test } from "vitest";
import { AppError } from "../src/lib/errors";
import { decodeCursor, encodeCursor } from "../src/repo/cursor";

const ATTRS = ["GSI1PK", "GSI1SK", "PK", "SK"] as const;
const MINE = "USER#3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f";
const THEIRS = "USER#00000000-0000-4000-8000-000000000000";
const key = {
  GSI1PK: MINE,
  GSI1SK: "TAKEN#2026-01-01T00:00:00.000Z#01J",
  PK: MINE,
  SK: "PHOTO#01J",
};
const partition = { attribute: "GSI1PK", value: MINE };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("cursor", () => {
  test("round-trips and is URL-safe", () => {
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, ATTRS, partition)).toEqual(key);
  });

  test.each([
    ["another user's partition", b64({ ...key, GSI1PK: THEIRS })],
    ["missing attribute", b64({ GSI1PK: MINE, GSI1SK: "x", PK: MINE })],
    ["extra attribute", b64({ ...key, evil: "x" })],
    ["non-string value", b64({ ...key, SK: { S: "PHOTO#1" } })],
    ["empty value", b64({ ...key, SK: "" })],
    ["array", b64([MINE])],
    ["null", b64(null)],
    ["not JSON", Buffer.from("{oops").toString("base64url")],
    ["not base64", "%%%"],
  ])("rejects %s with VALIDATION_ERROR", (_name, cursor) => {
    expect(() => decodeCursor(cursor, ATTRS, partition)).toThrow(AppError);
    try {
      decodeCursor(cursor, ATTRS, partition);
    } catch (err) {
      expect((err as AppError).code).toBe("VALIDATION_ERROR");
      expect((err as AppError).status).toBe(400);
    }
  });
});
