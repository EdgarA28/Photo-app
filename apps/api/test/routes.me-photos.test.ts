/** GET /me (5.5) and GET /photos, GET /photos/{id} (5.7) on DynamoDB Local. */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  apiErrorSchema,
  meResponseSchema,
  newId,
  photoPageSchema,
  photoSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Db, Repositories } from "../src/repo";
import {
  createPending,
  TEST_DEFAULT_QUOTA,
  createTestApi,
  markReady,
  newPhoto,
  newUserId,
} from "./helpers";

let db: Db;
let repos: Repositories;
let api: Awaited<ReturnType<typeof createTestApi>>["api"];
let profiles: Awaited<ReturnType<typeof createTestApi>>["profiles"];
beforeAll(async () => {
  ({ db, repos, api, profiles } = await createTestApi());
});

function errorCode(body: unknown) {
  return apiErrorSchema.parse(body).error.code;
}

async function upload(userId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await createPending(repos, newPhoto(userId))).photoId);
  return ids;
}

describe("GET /me (FR-ACC-1, FR-ACC-2)", () => {
  test("profile from the directory, zero usage and the default quota for a new user", async () => {
    const user = newUserId();
    profiles.set(user, { email: "ada@example.com", name: "Ada" });
    const { status, body } = await api(user, "GET", "/me");
    expect(status).toBe(200);
    expect(meResponseSchema.parse(body)).toEqual({
      userId: user,
      email: "ada@example.com",
      name: "Ada",
      username: null,
      usage: { bytesUsed: 0, photoCount: 0, quotaBytes: TEST_DEFAULT_QUOTA },
    });
  });

  test("counted usage and a per-user quota override", async () => {
    const user = newUserId();
    profiles.set(user, { email: "bob@example.com", name: null });
    const [photoId] = await upload(user, 2);
    await markReady(db, user, photoId!, 1234, "2025-05-05T10:00:00.000Z");
    await db.client.send(
      new PutCommand({
        TableName: db.table,
        Item: { PK: `USER#${user}`, SK: "USAGE", bytesUsed: 1234, photoCount: 1, quotaBytes: 5e9 },
      }),
    );
    const { body } = await api(user, "GET", "/me");
    // The pending photo isn't counted yet (ARCHITECTURE.md §8.2).
    expect(meResponseSchema.parse(body)).toMatchObject({
      name: null,
      usage: { bytesUsed: 1234, photoCount: 1, quotaBytes: 5e9 },
    });
  });

  test("401 for a user missing from the pool, and for anonymous callers", async () => {
    const missing = await api(newUserId(), "GET", "/me");
    expect(missing.status).toBe(401);
    expect(errorCode(missing.body)).toBe("UNAUTHORIZED");
    expect((await api(null, "GET", "/me")).status).toBe(401);
  });
});

describe("GET /photos (FR-GAL-1, FR-GAL-2)", () => {
  test("newest first; pending photos have no image URLs, ready ones own CloudFront paths", async () => {
    const user = newUserId();
    const [older, newer] = await upload(user, 2);
    await markReady(db, user, older!, 500, "2024-01-01T00:00:00.000Z");

    const { status, body } = await api(user, "GET", "/photos");
    expect(status).toBe(200);
    const page = photoPageSchema.parse(body);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((p) => p.photoId)).toEqual([newer, older]);
    expect(page.items[0]).toMatchObject({
      status: "pending",
      width: null,
      height: null,
      thumbUrl: null,
      previewUrl: null,
    });
    expect(page.items[1]).toMatchObject({
      status: "ready",
      sizeBytes: 500,
      width: 4000,
      height: 3000,
      takenAt: "2024-01-01T00:00:00.000Z",
      thumbUrl: `/users/${user}/thumbs/${older}.jpg`,
      previewUrl: `/users/${user}/previews/${older}.jpg`,
    });
    // Internal fields never leave the API.
    expect(Object.keys(page.items[1]!).sort()).toEqual(Object.keys(photoSchema.shape).sort());
  });

  test("sort=taken-asc and cursor pagination", async () => {
    const user = newUserId();
    const ids = await upload(user, 5);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `sort=taken-asc&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = photoPageSchema.parse((await api(user, "GET", `/photos?${query}`)).body);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((p) => p.photoId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
  });

  test("only the caller's photos; another user's cursor is rejected", async () => {
    const owner = newUserId();
    const intruder = newUserId();
    await upload(owner, 3);
    expect(photoPageSchema.parse((await api(intruder, "GET", "/photos")).body).items).toEqual([]);

    const ownerPage = photoPageSchema.parse((await api(owner, "GET", "/photos?limit=1")).body);
    const stolen = await api(intruder, "GET", `/photos?cursor=${ownerPage.nextCursor}`);
    expect(stolen.status).toBe(400);
    expect(errorCode(stolen.body)).toBe("VALIDATION_ERROR");
  });

  test.each(["sort=name", "limit=0", "limit=201", "cursor=%25%25"])(
    "400 for invalid query %s",
    async (query) => {
      const { status, body } = await api(newUserId(), "GET", `/photos?${query}`);
      expect(status).toBe(400);
      expect(errorCode(body)).toBe("VALIDATION_ERROR");
    },
  );
});

describe("GET /photos/{photoId}", () => {
  test("own photo", async () => {
    const user = newUserId();
    const [photoId] = await upload(user, 1);
    const { status, body } = await api(user, "GET", `/photos/${photoId}`);
    expect(status).toBe(200);
    expect(photoSchema.parse(body)).toMatchObject({ photoId, status: "pending" });
  });

  test("another user's photo is indistinguishable from a missing one (NFR-SEC-2)", async () => {
    const [photoId] = await upload(newUserId(), 1);
    const intruder = newUserId();
    const foreign = await api(intruder, "GET", `/photos/${photoId}`);
    const missing = await api(intruder, "GET", `/photos/${newId()}`);
    expect(foreign).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Photo not found" } },
    });
    expect(missing).toEqual(foreign);
  });

  test("400 for a malformed ID", async () => {
    const { status } = await api(newUserId(), "GET", "/photos/not-an-id");
    expect(status).toBe(400);
  });
});
