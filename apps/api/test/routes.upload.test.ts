/** POST /photos/upload-url (5.6) on DynamoDB Local with a fake photo bucket. */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_UPLOAD_BYTES,
  apiErrorSchema,
  photoPageSchema,
  uploadUrlResponseSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { UploadTarget } from "../src/lib/storage";
import type { Db, Repositories } from "../src/repo";
import {
  TEST_DEFAULT_QUOTA,
  TEST_UPLOAD_URL,
  createTestApi,
  markReady,
  newUserId,
} from "./helpers";

let db: Db;
let repos: Repositories;
let uploads: UploadTarget[];
let api: Awaited<ReturnType<typeof createTestApi>>["api"];
beforeAll(async () => {
  ({ db, repos, uploads, api } = await createTestApi());
});

function errorCode(body: unknown) {
  return apiErrorSchema.parse(body).error.code;
}

const request = { fileName: "IMG_0001.HEIC", contentType: "image/heic", sizeBytes: 3_000_000 };

async function setUsage(userId: string, bytesUsed: number, quotaBytes?: number) {
  await db.client.send(
    new PutCommand({
      TableName: db.table,
      Item: { PK: `USER#${userId}`, SK: "USAGE", bytesUsed, photoCount: 1, quotaBytes },
    }),
  );
}

describe("POST /photos/upload-url (FR-UP-3/4/7, NFR-SEC-6)", () => {
  test("creates a pending photo and returns a POST for its original key", async () => {
    const user = newUserId();
    const before = new Date().toISOString();
    const { status, body } = await api(user, "POST", "/photos/upload-url", request);
    expect(status).toBe(201);

    const { photoId, upload } = uploadUrlResponseSchema.parse(body);
    const key = `users/${user}/originals/${photoId}.heic`;
    expect(upload).toEqual({
      url: TEST_UPLOAD_URL,
      fields: { key, "Content-Type": "image/heic" },
    });
    expect(uploads.at(-1)).toEqual({ key, contentType: "image/heic", sizeBytes: 3_000_000 });

    const record = await repos.photos.get(user, photoId);
    expect(record).toMatchObject({
      status: "pending",
      fileName: "IMG_0001.HEIC",
      contentType: "image/heic",
      sizeBytes: 3_000_000,
      originalKey: key,
    });
    expect(record!.uploadedAt >= before).toBe(true);
    expect(record!.takenAt).toBe(record!.uploadedAt);
  });

  test("the pending photo shows up in the gallery straight away (FR-UP-6, FR-GAL-5)", async () => {
    const user = newUserId();
    const { body } = await api(user, "POST", "/photos/upload-url", request);
    const { photoId } = uploadUrlResponseSchema.parse(body);
    const page = photoPageSchema.parse((await api(user, "GET", "/photos")).body);
    expect(page.items).toEqual([
      expect.objectContaining({ photoId, status: "pending", thumbUrl: null }),
    ]);
  });

  test("file name is trimmed; each request gets its own photo", async () => {
    const user = newUserId();
    const first = uploadUrlResponseSchema.parse(
      (await api(user, "POST", "/photos/upload-url", { ...request, fileName: "  a.jpg " })).body,
    );
    const second = uploadUrlResponseSchema.parse(
      (await api(user, "POST", "/photos/upload-url", request)).body,
    );
    expect(first.photoId).not.toBe(second.photoId);
    expect((await repos.photos.get(user, first.photoId))!.fileName).toBe("a.jpg");
  });

  test.each([
    ["unsupported content type", { contentType: "image/gif" }],
    ["non-image content type", { contentType: "application/pdf" }],
    ["file over 50 MB (FR-UP-3)", { sizeBytes: MAX_UPLOAD_BYTES + 1 }],
    ["empty file", { sizeBytes: 0 }],
    ["fractional size", { sizeBytes: 1.5 }],
    ["blank file name", { fileName: "   " }],
    ["file name over 255 chars", { fileName: `${"a".repeat(252)}.jpg` }],
  ])("400 for %s, nothing created", async (_name, override) => {
    const user = newUserId();
    const before = uploads.length;
    const { status, body } = await api(user, "POST", "/photos/upload-url", {
      ...request,
      ...override,
    });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe("VALIDATION_ERROR");
    expect(uploads.length).toBe(before);
    expect(photoPageSchema.parse((await api(user, "GET", "/photos")).body).items).toEqual([]);
  });

  test("a file of exactly 50 MB is accepted", async () => {
    const { status } = await api(newUserId(), "POST", "/photos/upload-url", {
      ...request,
      sizeBytes: MAX_UPLOAD_BYTES,
    });
    expect(status).toBe(201);
  });
});

describe("quota (FR-UP-7, FR-ACC-2)", () => {
  test("413 QUOTA_EXCEEDED when the upload would pass the default quota; nothing created", async () => {
    const user = newUserId();
    await setUsage(user, TEST_DEFAULT_QUOTA - 100);
    const before = uploads.length;
    const { status, body } = await api(user, "POST", "/photos/upload-url", {
      ...request,
      sizeBytes: 101,
    });
    expect(status).toBe(413);
    expect(errorCode(body)).toBe("QUOTA_EXCEEDED");
    expect(uploads.length).toBe(before);
    expect(photoPageSchema.parse((await api(user, "GET", "/photos")).body).items).toEqual([]);
  });

  test("filling the quota exactly is allowed", async () => {
    const user = newUserId();
    await setUsage(user, TEST_DEFAULT_QUOTA - 100);
    const { status } = await api(user, "POST", "/photos/upload-url", {
      ...request,
      sizeBytes: 100,
    });
    expect(status).toBe(201);
  });

  test("a per-user quota override replaces the default", async () => {
    const user = newUserId();
    await setUsage(user, 0, 1_000_000);
    const over = await api(user, "POST", "/photos/upload-url", request);
    expect(over.status).toBe(413);
    const under = await api(user, "POST", "/photos/upload-url", { ...request, sizeBytes: 999_999 });
    expect(under.status).toBe(201);
  });

  test("usage counted by the thumbnail Lambda is what the check sees", async () => {
    const user = newUserId();
    const { body } = await api(user, "POST", "/photos/upload-url", request);
    const { photoId } = uploadUrlResponseSchema.parse(body);
    // Pending uploads aren't counted yet, so the quota only fills once the Lambda is done.
    const ok = await api(user, "POST", "/photos/upload-url", { ...request, sizeBytes: 11 });
    expect(ok.status).toBe(201);
    await markReady(db, user, photoId, TEST_DEFAULT_QUOTA - 10, "2025-01-01T00:00:00.000Z");
    const next = await api(user, "POST", "/photos/upload-url", { ...request, sizeBytes: 11 });
    expect(next.status).toBe(413);
  });

  test("one user's usage doesn't count against another (NFR-SEC-2)", async () => {
    const full = newUserId();
    await setUsage(full, TEST_DEFAULT_QUOTA);
    expect((await api(full, "POST", "/photos/upload-url", request)).status).toBe(413);
    expect((await api(newUserId(), "POST", "/photos/upload-url", request)).status).toBe(201);
  });
});

test("401 for anonymous callers", async () => {
  expect((await api(null, "POST", "/photos/upload-url", request)).status).toBe(401);
});

describe("retrying an upload with photoId (5.6a)", () => {
  async function start(user: string) {
    const { body } = await api(user, "POST", "/photos/upload-url", request);
    return uploadUrlResponseSchema.parse(body).photoId;
  }

  test("re-signs for the same pending photo: 200, same key, no new item", async () => {
    const user = newUserId();
    const photoId = await start(user);
    const { status, body } = await api(user, "POST", "/photos/upload-url", {
      ...request,
      fileName: "renamed.heic",
      photoId,
    });
    expect(status).toBe(200);
    const key = `users/${user}/originals/${photoId}.heic`;
    expect(uploadUrlResponseSchema.parse(body)).toEqual({
      photoId,
      upload: { url: TEST_UPLOAD_URL, fields: { key, "Content-Type": "image/heic" } },
    });
    expect(uploads.at(-1)).toEqual({ key, contentType: "image/heic", sizeBytes: 3_000_000 });

    const page = photoPageSchema.parse((await api(user, "GET", "/photos")).body);
    expect(page.items.map((p) => p.photoId)).toEqual([photoId]);
    // The first request's file name is kept.
    expect((await repos.photos.get(user, photoId))!.fileName).toBe("IMG_0001.HEIC");
  });

  test("409 CONFLICT once the photo is processed; the original can't be replaced", async () => {
    const user = newUserId();
    const photoId = await start(user);
    await markReady(db, user, photoId, 3_000_000, "2025-01-01T00:00:00.000Z");
    const before = uploads.length;
    const { status, body } = await api(user, "POST", "/photos/upload-url", { ...request, photoId });
    expect(status).toBe(409);
    expect(errorCode(body)).toBe("CONFLICT");
    expect(uploads.length).toBe(before);
  });

  test.each([
    ["a different content type", { contentType: "image/jpeg" }],
    ["a different size", { sizeBytes: 3_000_001 }],
  ])("409 CONFLICT for %s than the pending photo", async (_name, override) => {
    const user = newUserId();
    const photoId = await start(user);
    const before = uploads.length;
    const { status, body } = await api(user, "POST", "/photos/upload-url", {
      ...request,
      ...override,
      photoId,
    });
    expect(status).toBe(409);
    expect(errorCode(body)).toBe("CONFLICT");
    expect(uploads.length).toBe(before);
  });

  test("404 for an unknown photo and for another user's photo (NFR-SEC-2)", async () => {
    const owner = newUserId();
    const photoId = await start(owner);
    const other = newUserId();
    const before = uploads.length;
    const foreign = await api(other, "POST", "/photos/upload-url", { ...request, photoId });
    const unknown = await api(other, "POST", "/photos/upload-url", {
      ...request,
      photoId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    });
    for (const res of [foreign, unknown]) {
      expect(res.status).toBe(404);
      expect(errorCode(res.body)).toBe("NOT_FOUND");
    }
    expect(foreign.body).toEqual(unknown.body);
    expect(uploads.length).toBe(before);
    // Nothing was created for the other user either.
    expect(photoPageSchema.parse((await api(other, "GET", "/photos")).body).items).toEqual([]);
  });

  test("413 QUOTA_EXCEEDED when usage grew past the quota since the photo was created", async () => {
    const user = newUserId();
    const photoId = await start(user);
    await setUsage(user, TEST_DEFAULT_QUOTA - 1000);
    const before = uploads.length;
    const { status, body } = await api(user, "POST", "/photos/upload-url", { ...request, photoId });
    expect(status).toBe(413);
    expect(errorCode(body)).toBe("QUOTA_EXCEEDED");
    expect(uploads.length).toBe(before);
    // The photo stays pending, so it can be retried once space is freed.
    expect((await repos.photos.get(user, photoId))!.status).toBe("pending");
  });

  test("400 for a malformed photoId", async () => {
    const res = await api(newUserId(), "POST", "/photos/upload-url", { ...request, photoId: "x" });
    expect(res.status).toBe(400);
  });
});
