/** GET /photos/{id}/download-url (5.8) and DELETE /photos/{id} (5.9) on DynamoDB Local. */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  apiErrorSchema,
  downloadUrlResponseSchema,
  newId,
  previewKey,
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
} from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let db: Db;
let repos: Repositories;
let api: TestApi["api"];
let downloads: DownloadTarget[];
let deletes: string[][];
let hooks: TestApi["hooks"];
beforeAll(async () => {
  ({ db, repos, api, downloads, deletes, hooks } = await createTestApi());
});
beforeEach(() => {
  downloads.length = 0;
  deletes.length = 0;
  delete hooks.onDelete;
});

function errorCode(body: unknown) {
  return apiErrorSchema.parse(body).error.code;
}

async function readyPhoto(userId: string, size = 1000) {
  const photo = await createPending(repos, newPhoto(userId, { sizeBytes: size }));
  await markReady(db, userId, photo.photoId, size, "2025-06-01T12:00:00.000Z");
  return photo;
}

describe("GET /photos/{photoId}/download-url (FR-DL-1, FR-DL-2)", () => {
  test("own photo: signed URL for its original under its file name, expiring in 5 min", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);

    const before = Date.now();
    const res = await api(user, "GET", `/photos/${photo.photoId}/download-url`);

    expect(res.status).toBe(200);
    const body = downloadUrlResponseSchema.parse(res.body);
    expect(body.url.startsWith(TEST_DOWNLOAD_URL)).toBe(true);
    expect(downloads).toEqual([{ key: photo.originalKey, fileName: photo.fileName }]);
    const ttl = (Date.parse(body.expiresAt) - before) / 1000;
    expect(ttl).toBeGreaterThan(DOWNLOAD_URL_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(DOWNLOAD_URL_TTL_SECONDS + 5);
  });

  test("failed photos keep their original and can be downloaded", async () => {
    const user = newUserId();
    const photo = await createPending(repos, newPhoto(user));
    // Status only: the route doesn't look at usage.
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        Key: { PK: `USER#${user}`, SK: `PHOTO#${photo.photoId}` },
        UpdateExpression: "SET #status = :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":failed": "failed" },
      }),
    );

    const res = await api(user, "GET", `/photos/${photo.photoId}/download-url`);
    expect(res.status).toBe(200);
  });

  test("pending photo → 409 CONFLICT, nothing signed", async () => {
    const user = newUserId();
    const photo = await createPending(repos, newPhoto(user));

    const res = await api(user, "GET", `/photos/${photo.photoId}/download-url`);
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONFLICT");
    expect(downloads).toEqual([]);
  });

  test("another user's photo and unknown IDs → 404 (NFR-SEC-2)", async () => {
    const photo = await readyPhoto(newUserId());

    for (const id of [photo.photoId, newId()]) {
      const res = await api(newUserId(), "GET", `/photos/${id}/download-url`);
      expect(res.status).toBe(404);
      expect(errorCode(res.body)).toBe("NOT_FOUND");
    }
    expect(downloads).toEqual([]);
  });

  test("invalid ID → 400, anonymous → 401", async () => {
    expect((await api(newUserId(), "GET", "/photos/nope/download-url")).status).toBe(400);
    expect((await api(null, "GET", `/photos/${newId()}/download-url`)).status).toBe(401);
  });
});

describe("DELETE /photos/{photoId} (FR-DEL-1, FR-DEL-3)", () => {
  const keysOf = (userId: string, photo: { photoId: string; originalKey: string }) => [
    photo.originalKey,
    thumbKey(userId, photo.photoId),
    previewKey(userId, photo.photoId),
  ];

  test("ready photo goes to the trash: out of gallery and albums, files and usage stay (FR-DEL-3)", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user, 700);
    const other = await readyPhoto(user, 300);
    const album = await repos.albums.create({
      ownerId: user,
      albumId: newId(),
      name: "Trip",
      createdAt: new Date().toISOString(),
    });
    await repos.albums.addPhotos(user, album.albumId, [photo.photoId, other.photoId], "now");
    await repos.albums.update(user, album.albumId, { coverPhotoId: photo.photoId });

    const res = await api(user, "DELETE", `/photos/${photo.photoId}`);

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(deletes).toEqual([]);
    const trashed = await repos.photos.get(user, photo.photoId);
    expect(trashed?.trashedAt).toBeDefined();
    expect(trashed?.trashedAlbumIds).toEqual(new Set([album.albumId]));
    expect(await repos.albums.hasPhoto(album.albumId, photo.photoId)).toBe(false);
    const after = await repos.albums.get(user, album.albumId);
    expect(after?.photoCount).toBe(1);
    expect(after?.coverPhotoId).toBeUndefined();
    const gallery = await repos.photos.list(user, { sort: "taken-desc", limit: 10 });
    expect(gallery.items.map((p) => p.photoId)).toEqual([other.photoId]);
    expect(await repos.usage.get(user)).toMatchObject({
      bytesUsed: 1000,
      photoCount: 2,
      bytesReserved: 1000,
    });
  });

  test("pending photo: releases its reservation, nothing counted", async () => {
    const user = newUserId();
    const photo = await createPending(repos, newPhoto(user, { sizeBytes: 5000 }));

    expect((await api(user, "DELETE", `/photos/${photo.photoId}`)).status).toBe(204);
    expect(deletes).toEqual([keysOf(user, photo)]);
    expect(await repos.usage.get(user)).toMatchObject({
      bytesUsed: 0,
      photoCount: 0,
      bytesReserved: 0,
    });
  });

  test("thumbnail Lambda finishes during the delete: objects are deleted again", async () => {
    const user = newUserId();
    const photo = await createPending(repos, newPhoto(user, { sizeBytes: 900 }));
    // Simulates the Lambda writing thumb/preview and marking the photo ready right after our
    // first object delete.
    hooks.onDelete = async () => {
      delete hooks.onDelete;
      await markReady(db, user, photo.photoId, 800, "2025-06-01T12:00:00.000Z");
    };

    expect((await api(user, "DELETE", `/photos/${photo.photoId}`)).status).toBe(204);
    expect(deletes).toEqual([keysOf(user, photo), keysOf(user, photo)]);
    expect(await repos.photos.get(user, photo.photoId)).toBeNull();
    // Deleted as the counted photo it had become.
    expect(await repos.usage.get(user)).toMatchObject({
      bytesUsed: 0,
      photoCount: 0,
      bytesReserved: 0,
    });
  });

  test("an S3 failure leaves the photo in place, so a retry can finish", async () => {
    const user = newUserId();
    const photo = await createPending(repos, newPhoto(user));
    hooks.onDelete = async () => {
      throw new Error("S3 unavailable");
    };

    expect((await api(user, "DELETE", `/photos/${photo.photoId}`)).status).toBe(500);
    expect(await repos.photos.get(user, photo.photoId)).not.toBeNull();

    delete hooks.onDelete;
    expect((await api(user, "DELETE", `/photos/${photo.photoId}`)).status).toBe(204);
    expect(await repos.photos.get(user, photo.photoId)).toBeNull();
  });

  test("another user's photo → 404 and untouched; deleting twice is fine (NFR-SEC-2)", async () => {
    const owner = newUserId();
    const photo = await readyPhoto(owner);

    const res = await api(newUserId(), "DELETE", `/photos/${photo.photoId}`);
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("NOT_FOUND");
    expect(deletes).toEqual([]);
    expect(await repos.photos.get(owner, photo.photoId)).not.toBeNull();

    // In the trash already: still 204, unchanged.
    expect((await api(owner, "DELETE", `/photos/${photo.photoId}`)).status).toBe(204);
    const trashedAt = (await repos.photos.get(owner, photo.photoId))?.trashedAt;
    expect((await api(owner, "DELETE", `/photos/${photo.photoId}`)).status).toBe(204);
    expect((await repos.photos.get(owner, photo.photoId))?.trashedAt).toBe(trashedAt);
    expect((await api(owner, "DELETE", `/photos/${newId()}`)).status).toBe(404);
  });

  test("invalid ID → 400, anonymous → 401", async () => {
    expect((await api(newUserId(), "DELETE", "/photos/nope")).status).toBe(400);
    expect((await api(null, "DELETE", `/photos/${newId()}`)).status).toBe(401);
  });
});
