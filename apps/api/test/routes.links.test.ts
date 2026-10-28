/** Public photo links (FR-SHR-8): create as the owner, open and download without a login. */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  PHOTO_LINK_TTL_SECONDS,
  apiErrorSchema,
  downloadUrlResponseSchema,
  linkedPhotoSchema,
  newId,
  photoLinkSchema,
  previewKey,
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

async function readyPhoto(userId: string) {
  const photo = await createPending(repos, newPhoto(userId));
  await markReady(db, userId, photo.photoId, 1000, "2025-06-01T12:00:00.000Z");
  return photo;
}

async function createLink(userId: string, photoId: string) {
  const res = await api(userId, "POST", `/photos/${photoId}/links`);
  expect(res.status).toBe(201);
  return photoLinkSchema.parse(res.body);
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

describe("POST /photos/{photoId}/links", () => {
  test("creates a 15-minute link with an unguessable token", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);
    const before = Date.now();

    const link = await createLink(user, photo.photoId);

    expect(link.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link.path).toBe(`/s/${link.token}`);
    const ttl = (Date.parse(link.expiresAt) - before) / 1000;
    expect(ttl).toBeGreaterThan(PHOTO_LINK_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(PHOTO_LINK_TTL_SECONDS + 5);
    expect((await createLink(user, photo.photoId)).token).not.toBe(link.token);
  });

  test("pending or trashed photos → 409; another user's or unknown → 404; anonymous → 401", async () => {
    const user = newUserId();
    const pending = await createPending(repos, newPhoto(user));
    expect((await api(user, "POST", `/photos/${pending.photoId}/links`)).status).toBe(409);

    const trashed = await readyPhoto(user);
    await api(user, "DELETE", `/photos/${trashed.photoId}`);
    expect((await api(user, "POST", `/photos/${trashed.photoId}/links`)).status).toBe(409);

    const photo = await readyPhoto(user);
    for (const [as, id] of [
      [newUserId(), photo.photoId],
      [user, newId()],
    ] as const) {
      const res = await api(as, "POST", `/photos/${id}/links`);
      expect(res.status).toBe(404);
      expect(errorCode(res.body)).toBe("NOT_FOUND");
    }
    expect((await api(null, "POST", `/photos/${photo.photoId}/links`)).status).toBe(401);
  });
});

describe("GET /links/{token} and /links/{token}/download-url (no login)", () => {
  test("anyone sees the preview, signed only until the link expires", async () => {
    const owner = newUserId();
    const photo = await readyPhoto(owner);
    const link = await createLink(owner, photo.photoId);

    const res = await api(null, "GET", `/links/${link.token}`);

    expect(res.status).toBe(200);
    const body = linkedPhotoSchema.parse(res.body);
    expect(body).toMatchObject({ photoId: photo.photoId, width: 4000, height: 3000 });
    expect(body.expiresAt).toBe(link.expiresAt);
    const signedUntil = verifySignedUrl(body.previewUrl, `/${previewKey(owner, photo.photoId)}`);
    expect(signedUntil).toBe(Math.floor(Date.parse(link.expiresAt) / 1000));
    // Signed-in users get the same.
    expect((await api(newUserId(), "GET", `/links/${link.token}`)).status).toBe(200);
  });

  test("anyone downloads the original under its file name", async () => {
    const owner = newUserId();
    const photo = await readyPhoto(owner);
    const link = await createLink(owner, photo.photoId);

    const res = await api(null, "GET", `/links/${link.token}/download-url`);

    expect(res.status).toBe(200);
    expect(downloadUrlResponseSchema.parse(res.body).url.startsWith(TEST_DOWNLOAD_URL)).toBe(true);
    expect(downloads).toEqual([{ key: photo.originalKey, fileName: photo.fileName }]);
  });

  test("expired, unknown, deleted or trashed → the same 404", async () => {
    const owner = newUserId();
    const expired = await createLink(owner, (await readyPhoto(owner)).photoId);
    await expire(expired.token, new Date(Date.now() - 1000).toISOString());

    const trashedPhoto = await readyPhoto(owner);
    const trashed = await createLink(owner, trashedPhoto.photoId);
    await api(owner, "DELETE", `/photos/${trashedPhoto.photoId}`);

    const deletedPhoto = await readyPhoto(owner);
    const deleted = await createLink(owner, deletedPhoto.photoId);
    await api(owner, "DELETE", `/photos/${deletedPhoto.photoId}`);
    await api(owner, "DELETE", `/trash/${deletedPhoto.photoId}`);

    const unknown = "A".repeat(22);
    const responses = [];
    for (const token of [expired.token, trashed.token, deleted.token, unknown]) {
      for (const path of [`/links/${token}`, `/links/${token}/download-url`]) {
        const res = await api(null, "GET", path);
        expect(res.status).toBe(404);
        responses.push(res.body);
      }
    }
    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(downloads).toEqual([]);
  });

  test("a malformed token → 400", async () => {
    expect((await api(null, "GET", "/links/short")).status).toBe(400);
    expect((await api(null, "GET", `/links/${"A".repeat(21)}*`)).status).toBe(400);
  });

  test("other routes stay behind the login", async () => {
    expect((await api(null, "GET", "/photos")).status).toBe(401);
    expect((await api(null, "GET", "/links")).status).toBe(401);
  });
});
