import { describe, expect, test } from "vitest";
import { GOOGLE_IMPORT_CALLBACK_PATH, MAX_FILE_NAME_LENGTH } from "../constants";
import {
  apiErrorSchema,
  importClaimId,
  importCopyMessageSchema,
  importMessageSchema,
  importSchema,
  isFinalImportStatus,
  startGoogleImportRequestSchema,
  startGoogleImportResponseSchema,
} from "../index";

// Import from Google Photos (13.5b; FR-IMP-1–6, §9, §10.1, NFR-SEC-10).
const IMPORT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const USER_ID = "4428e4a8-c0a1-70de-9b5b-2c3f1e0a7d11";
const VERIFIER = "a".repeat(43);
const REDIRECT = `https://dopqu53s0gzhf.cloudfront.net${GOOGLE_IMPORT_CALLBACK_PATH}`;

describe("startGoogleImportRequestSchema (FR-IMP-1, §11.5)", () => {
  const valid = { code: "4/0Ab-code", codeVerifier: VERIFIER, redirectUri: REDIRECT };

  test("accepts the callback on https and on localhost", () => {
    expect(startGoogleImportRequestSchema.parse(valid)).toEqual(valid);
    const local = { ...valid, redirectUri: `http://localhost:5173${GOOGLE_IMPORT_CALLBACK_PATH}` };
    expect(startGoogleImportRequestSchema.safeParse(local).success).toBe(true);
  });

  test.each([
    ["other path", "https://app.example/gallery"],
    ["trailing slash", `${REDIRECT}/`],
    ["query", `${REDIRECT}?next=/x`],
    ["fragment", `${REDIRECT}#x`],
    ["credentials", `https://u:p@app.example${GOOGLE_IMPORT_CALLBACK_PATH}`],
    ["other scheme", `javascript://app.example${GOOGLE_IMPORT_CALLBACK_PATH}`],
    ["not a URL", "callback"],
  ])("rejects a redirect URI with %s", (_, redirectUri) => {
    expect(startGoogleImportRequestSchema.safeParse({ ...valid, redirectUri }).success).toBe(false);
  });

  test("code verifier follows RFC 7636 (43–128 unreserved characters)", () => {
    const parse = (codeVerifier: string) =>
      startGoogleImportRequestSchema.safeParse({ ...valid, codeVerifier }).success;
    expect(parse("A-._~".repeat(9))).toBe(true);
    expect(parse("a".repeat(128))).toBe(true);
    expect(parse("a".repeat(42))).toBe(false);
    expect(parse("a".repeat(129))).toBe(false);
    expect(parse(`${"a".repeat(42)}+`)).toBe(false);
  });

  test("code is required and bounded", () => {
    expect(startGoogleImportRequestSchema.safeParse({ ...valid, code: "" }).success).toBe(false);
    const long = { ...valid, code: "a".repeat(2049) };
    expect(startGoogleImportRequestSchema.safeParse(long).success).toBe(false);
  });
});

describe("startGoogleImportResponseSchema", () => {
  test("picker URI must be https", () => {
    const body = {
      importId: IMPORT_ID,
      pickerUri: "https://photos.google.com/picker/abc",
      expiresAt: "2026-11-21T20:00:00.000Z",
    };
    expect(startGoogleImportResponseSchema.parse(body)).toEqual(body);
    const http = { ...body, pickerUri: "http://photos.google.com/picker/abc" };
    expect(startGoogleImportResponseSchema.safeParse(http).success).toBe(false);
  });
});

describe("importSchema (GET /imports/{id}, FR-IMP-5)", () => {
  const progress = {
    status: "copying",
    total: 50,
    done: 47,
    failed: 1,
    skipped: 2,
    failedReasons: { QUOTA_EXCEEDED: 1 },
  };

  test("parses progress with failure reasons", () => {
    expect(importSchema.parse(progress)).toEqual(progress);
    expect(importSchema.parse({ ...progress, failedReasons: {} }).failedReasons).toEqual({});
  });

  test("rejects unknown statuses, reasons and negative counts", () => {
    expect(importSchema.safeParse({ ...progress, status: "paused" }).success).toBe(false);
    const reason = { ...progress, failedReasons: { BROKEN: 1 } };
    expect(importSchema.safeParse(reason).success).toBe(false);
    expect(importSchema.safeParse({ ...progress, done: -1 }).success).toBe(false);
  });

  test("done, cancelled and expired are final", () => {
    expect(["picking", "listing", "copying"].some((s) => isFinalImportStatus(s as never))).toBe(
      false,
    );
    expect(["done", "cancelled", "expired"].every((s) => isFinalImportStatus(s as never))).toBe(
      true,
    );
  });
});

describe("import queue messages (§10.1)", () => {
  const copy = {
    type: "copy",
    userId: USER_ID,
    importId: IMPORT_ID,
    mediaItemId: "AF1QipN_x-9",
    baseUrl: "https://lh3.googleusercontent.com/ppa/abc",
    fileName: "IMG_0001.HEIC",
    contentType: "image/heic",
    createTime: "2024-07-14T09:30:00Z",
  };

  test("tells list and copy apart by type", () => {
    const list = { type: "list", userId: USER_ID, importId: IMPORT_ID };
    expect(importMessageSchema.parse(list)).toEqual(list);
    expect(importMessageSchema.parse(copy)).toEqual(copy);
    expect(importMessageSchema.safeParse({ ...list, type: "other" }).success).toBe(false);
  });

  test("accepts Google's createTime with fractions or an offset", () => {
    for (const createTime of ["2024-07-14T09:30:00.123456Z", "2024-07-14T09:30:00+02:00"]) {
      expect(importCopyMessageSchema.safeParse({ ...copy, createTime }).success).toBe(true);
    }
  });

  test("copies only photo types (videos are skipped, FR-IMP-3, FR-VID-10)", () => {
    const video = { ...copy, contentType: "video/mp4" };
    expect(importCopyMessageSchema.safeParse(video).success).toBe(false);
  });

  test.each([
    ["a media item ID with key characters", { mediaItemId: "a#b" }],
    ["an empty media item ID", { mediaItemId: "" }],
    ["an http base URL", { baseUrl: "http://lh3.googleusercontent.com/x" }],
    ["a long file name", { fileName: "a".repeat(MAX_FILE_NAME_LENGTH + 1) }],
    ["a bad user ID", { userId: "someone" }],
  ])("rejects %s", (_, change) => {
    expect(importCopyMessageSchema.safeParse({ ...copy, ...change }).success).toBe(false);
  });
});

test("importClaimId is gp-{importId}-{mediaItemId} (§8.2, FR-IMP-6)", () => {
  expect(importClaimId(IMPORT_ID, "AF1Qip")).toBe(`gp-${IMPORT_ID}-AF1Qip`);
});

test("GOOGLE_AUTH_FAILED is an API error code (§9)", () => {
  const body = { error: { code: "GOOGLE_AUTH_FAILED", message: "Google rejected the code" } };
  expect(apiErrorSchema.parse(body)).toEqual(body);
});
