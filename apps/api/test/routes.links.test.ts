/** Public photo links (FR-SHR-8): create as the owner, open and download without a login. */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_PHOTOS_PER_LINK,
  PHOTO_LINK_TTL_SECONDS,
  apiErrorSchema,
  downloadUrlResponseSchema,
  newId,
  photoLinkSchema,
  previewKey,
  sharedLinkSchema,
  thumbKey,
} from "@photo-app/shared";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DownloadTarget } from "../src/lib/storage";
import type { Db, Repositories } from "../src/repo";
import {
  TEST_DOWNLOAD_URL,
  createPending,
  createTestApi,
  markReady,
  newPhoto,
  newUserId,
  verifySignedUrl,
} from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let db: Db;
let repos: Repositories;
let api: TestApi["api"];
let downloads: DownloadTarget[];
beforeAll(async () => {
  ({ db, repos, api, downloads } = await createTestApi());
});
beforeEach(() => {
  downloads.length = 0;
});

async function readyPhoto(userId: string, takenAt = "2025-06-01T12:00:00.000Z") {
  const photo = await createPending(repos, newPhoto(userId));
  await markReady(db, userId, photo.photoId, 1000, takenAt);
  return photo;
}

async function createLink(userId: string, photoIds: string[]) {
  const res = await api(userId, "POST", "/links", { photoIds });
  expect(res.status).toBe(201);
  return photoLinkSchema.parse(res.body);
}

async function openLink(token: string) {
  const res = await api(null, "GET", `/links/${token}`);
  expect(res.status).toBe(200);
  return sharedLinkSchema.parse(res.body);
}

const errorCode = (body: unknown) => apiErrorSchema.parse(body).error.code;

/** Moves a link's expiry, as if time had passed. */
async function expire(token: string, expiresAt: string) {
  await db.client.send(
    new UpdateCommand({
      TableName: db.table,
      Key: { PK: `LINK#${token}`, SK: "LINK" },
      UpdateExpression: "SET expiresAt = :e",
      ExpressionAttributeValues: { ":e": expiresAt },
    }),
  );
}

describe("POST /links", () => {
  test("creates a 15-minute link with an unguessable token", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);
    const before = Date.now();

    const link = await createLink(user, [photo.photoId]);

    expect(link.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link.path).toBe(`/s/${link.token}`);
    expect(link.photoCount).toBe(1);
    const ttl = (Date.parse(link.expiresAt) - before) / 1000;
    expect(ttl).toBeGreaterThan(PHOTO_LINK_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(PHOTO_LINK_TTL_SECONDS + 5);
    expect((await createLink(user, [photo.photoId])).token).not.toBe(link.token);
  });

  test("several photos; pending, trashed, other users' and unknown ones are left out", async () => {
    const user = newUserId();
    const a = await readyPhoto(user);
    const b = await readyPhoto(user);
    const pending = await createPending(repos, newPhoto(user));
    const trashed = await readyPhoto(user);
    await api(user, "DELETE", `/photos/${trashed.photoId}`);
    const foreign = await readyPhoto(newUserId());

    const link = await createLink(user, [
      a.photoId,
      pending.photoId,
      b.photoId,
      trashed.photoId,
      foreign.photoId,
      newId(),
      a.photoId,
    ]);

    expect(link.photoCount).toBe(2);
    const shown = await openLink(link.token);
    expect(shown.photos.map((p) => p.photoId).sort()).toEqual([a.photoId, b.photoId].sort());
  });

  test("nothing shareable → 409; nothing of the caller's → 404; limits; anonymous → 401", async () => {
    const user = newUserId();
    const pending = await createPending(repos, newPhoto(user));
    const res = await api(user, "POST", "/links", { photoIds: [pending.photoId] });
    expect(res.status).toBe(409);

    const photo = await readyPhoto(user);
    for (const [as, ids] of [
      [newUserId(), [photo.photoId]],
      [user, [newId()]],
    ] as const) {
      const r = await api(as, "POST", "/links", { photoIds: ids });
      expect(r.status).toBe(404);
      expect(errorCode(r.body)).toBe("NOT_FOUND");
    }
    expect((await api(user, "POST", "/links", { photoIds: [] })).status).toBe(400);
    const tooMany = Array.from({ length: MAX_PHOTOS_PER_LINK + 1 }, () => newId());
    expect((await api(user, "POST", "/links", { photoIds: tooMany })).status).toBe(400);
    expect((await api(null, "POST", "/links", { photoIds: [photo.photoId] })).status).toBe(401);
  });
});

describe("GET /links/{token} and the downloads (no login)", () => {
  test("anyone sees the photos, newest first, signed only until the link expires", async () => {
    const owner = newUserId();
    const older = await readyPhoto(owner, "2024-01-01T10:00:00.000Z");
    const newer = await readyPhoto(owner, "2025-01-01T10:00:00.000Z");
    const link = await createLink(owner, [older.photoId, newer.photoId]);

    const body = await openLink(link.token);

    expect(body.expiresAt).toBe(link.expiresAt);
    expect(body.photos.map((p) => p.photoId)).toEqual([newer.photoId, older.photoId]);
    const first = body.photos[0]!;
    expect(first).toMatchObject({ width: 4000, height: 3000 });
    const until = Math.floor(Date.parse(link.expiresAt) / 1000);
    expect(verifySignedUrl(first.previewUrl, `/${previewKey(owner, newer.photoId)}`)).toBe(until);
    expect(verifySignedUrl(first.thumbUrl, `/${thumbKey(owner, newer.photoId)}`)).toBe(until);
    // Signed-in users get the same.
    expect((await api(newUserId(), "GET", `/links/${link.token}`)).status).toBe(200);
  });

  test("anyone downloads an original of the link under its file name", async () => {
    const owner = newUserId();
    const photo = await readyPhoto(owner);
    const link = await createLink(owner, [photo.photoId]);

    const res = await api(null, "GET", `/links/${link.token}/photos/${photo.photoId}/download-url`);

    expect(res.status).toBe(200);
    expect(downloadUrlResponseSchema.parse(res.body).url.startsWith(TEST_DOWNLOAD_URL)).toBe(true);
    expect(downloads).toEqual([{ key: photo.originalKey, fileName: photo.fileName }]);
  });

  test("a photo trashed after the link was made drops out; the others stay", async () => {
    const owner = newUserId();
    const kept = await readyPhoto(owner);
    const trashed = await readyPhoto(owner);
    const link = await createLink(owner, [kept.photoId, trashed.photoId]);
    await api(owner, "DELETE", `/photos/${trashed.photoId}`);

    expect((await openLink(link.token)).photos.map((p) => p.photoId)).toEqual([kept.photoId]);
    const res = await api(
      null,
      "GET",
      `/links/${link.token}/photos/${trashed.photoId}/download-url`,
    );
    expect(res.status).toBe(404);
  });

  test("expired, unknown, emptied, or a photo not in the link → the same 404", async () => {
    const owner = newUserId();
    const photo = await readyPhoto(owner);
    const expired = await createLink(owner, [photo.photoId]);
    await expire(expired.token, new Date(Date.now() - 1000).toISOString());

    const emptiedPhoto = await readyPhoto(owner);
    const emptied = await createLink(owner, [emptiedPhoto.photoId]);
    await api(owner, "DELETE", `/photos/${emptiedPhoto.photoId}`);

    // Another photo of the same owner isn't reachable through a link that doesn't hold it.
    const live = await createLink(owner, [photo.photoId]);
    const other = await readyPhoto(owner);

    const unknown = "A".repeat(22);
    const paths = [
      `/links/${expired.token}`,
      `/links/${expired.token}/photos/${photo.photoId}/download-url`,
      `/links/${emptied.token}`,
      `/links/${unknown}`,
      `/links/${unknown}/photos/${photo.photoId}/download-url`,
      `/links/${live.token}/photos/${other.photoId}/download-url`,
    ];
    const bodies = [];
    for (const path of paths) {
      const res = await api(null, "GET", path);
      expect(res.status).toBe(404);
      bodies.push(JSON.stringify(res.body));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(downloads).toEqual([]);
  });

  test("a malformed token or photo ID → 400", async () => {
    expect((await api(null, "GET", "/links/short")).status).toBe(400);
    expect(
      (await api(null, "GET", `/links/${"A".repeat(22)}/photos/nope/download-url`)).status,
    ).toBe(400);
  });

  test("other routes stay behind the login", async () => {
    expect((await api(null, "GET", "/photos")).status).toBe(401);
    expect((await api(null, "GET", "/links")).status).toBe(401);
  });
});
