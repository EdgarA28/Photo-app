/**
 * Share recipients' read access (5.13, spec §8.2 "Can user X see photo P?"): album photos and
 * original downloads through an album shared with them, and nothing else (FR-SHR-4, NFR-SEC-2).
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  SHARED_IMAGE_URL_TTL_SECONDS,
  downloadUrlResponseSchema,
  newId,
  photoPageSchema,
  photoSchema,
} from "@photo-app/shared";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DownloadTarget } from "../src/lib/storage";
import type { Db, PhotoRecord, Repositories } from "../src/repo";
import {
  createPending,
  createTestApi,
  markReady,
  newPhoto,
  newUserId,
  nextIso,
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

async function readyPhoto(userId: string): Promise<PhotoRecord> {
  const photo = await createPending(repos, newPhoto(userId));
  await markReady(db, userId, photo.photoId, 1000, "2025-06-01T12:00:00.000Z");
  return (await repos.photos.get(userId, photo.photoId))!;
}

async function setStatus(userId: string, photoId: string, status: "failed") {
  await db.client.send(
    new UpdateCommand({
      TableName: db.table,
      Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
      UpdateExpression: "SET #status = :s",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":s": status },
    }),
  );
}

/**
 * Owner with album "shared" (ready, pending and failed photo, shared with `friend`) and album
 * "private" (with a ready photo that isn't in the shared album).
 */
async function setup() {
  const owner = newUserId();
  const friend = newUserId();
  const shared = await repos.albums.create({
    ownerId: owner,
    albumId: newId(),
    name: "Shared",
    createdAt: nextIso(),
  });
  const hidden = await repos.albums.create({
    ownerId: owner,
    albumId: newId(),
    name: "Private",
    createdAt: nextIso(),
  });
  const ready = await readyPhoto(owner);
  const pending = await createPending(repos, newPhoto(owner));
  const failed = await createPending(repos, newPhoto(owner));
  await setStatus(owner, failed.photoId, "failed");
  const privatePhoto = await readyPhoto(owner);
  await repos.albums.addPhotos(
    owner,
    shared.albumId,
    [ready.photoId, pending.photoId, failed.photoId],
    nextIso(),
  );
  await repos.albums.addPhotos(owner, hidden.albumId, [privatePhoto.photoId], nextIso());
  await repos.shares.create({
    albumId: shared.albumId,
    ownerId: owner,
    userId: friend,
    email: "friend@example.com",
    status: "accepted",
    sharedAt: nextIso(),
  });
  return { owner, friend, shared, hidden, ready, pending, failed, privatePhoto };
}

describe("GET /photos/{photoId}?albumId= as a share recipient (7.4)", () => {
  test("a shared photo, with signed thumbnail and preview URLs", async () => {
    const { owner, friend, shared, ready } = await setup();

    const res = await api(friend, "GET", `/photos/${ready.photoId}?albumId=${shared.albumId}`);

    expect(res.status).toBe(200);
    const photo = photoSchema.parse(res.body);
    expect(photo).toMatchObject({ photoId: ready.photoId, status: "ready" });
    verifySignedUrl(photo.thumbUrl!, `/users/${owner}/thumbs/${ready.photoId}.jpg`);
    verifySignedUrl(photo.previewUrl!, `/users/${owner}/previews/${ready.photoId}.jpg`);
  });

  test("only ready photos of that album, only while it is shared → else 404", async () => {
    const { friend, shared, hidden, pending, privatePhoto, ready } = await setup();
    const get = (photoId: string, albumId: string) =>
      api(friend, "GET", `/photos/${photoId}?albumId=${albumId}`);

    expect((await get(pending.photoId, shared.albumId)).status).toBe(404);
    expect((await get(privatePhoto.photoId, shared.albumId)).status).toBe(404);
    expect((await get(privatePhoto.photoId, hidden.albumId)).status).toBe(404);
    expect((await api(friend, "GET", `/photos/${ready.photoId}`)).status).toBe(404);

    await repos.shares.delete(shared.albumId, friend);
    expect((await get(ready.photoId, shared.albumId)).status).toBe(404);
  });

  test("the owner gets stable paths, with or without albumId", async () => {
    const { owner, shared, ready } = await setup();
    const photo = photoSchema.parse(
      (await api(owner, "GET", `/photos/${ready.photoId}?albumId=${shared.albumId}`)).body,
    );
    expect(photo.previewUrl).toBe(`/users/${owner}/previews/${ready.photoId}.jpg`);
  });
});

const downloadPath = (photoId: string, albumId?: string) =>
  `/photos/${photoId}/download-url${albumId ? `?albumId=${albumId}` : ""}`;

describe("GET /albums/{albumId}/photos as a share recipient", () => {
  test("sees the ready photos, each thumbnail with its own 15-min signed URL (7.4)", async () => {
    const { owner, friend, shared, ready } = await setup();
    const before = Math.floor(Date.now() / 1000);

    const res = await api(friend, "GET", `/albums/${shared.albumId}/photos`);

    expect(res.status).toBe(200);
    const page = photoPageSchema.parse(res.body);
    expect(page.items).toEqual([
      expect.objectContaining({
        photoId: ready.photoId,
        status: "ready",
        fileName: ready.fileName,
        width: 4000,
      }),
    ]);
    const [photo] = page.items;
    // Signed for exactly the owner's file; the recipient's cookie doesn't cover that prefix.
    const thumbExpiry = verifySignedUrl(
      photo!.thumbUrl!,
      `/users/${owner}/thumbs/${ready.photoId}.jpg`,
    );
    expect(thumbExpiry - before).toBeGreaterThanOrEqual(SHARED_IMAGE_URL_TTL_SECONDS);
    expect(thumbExpiry - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(
      SHARED_IMAGE_URL_TTL_SECONDS,
    );
    // Previews are signed one at a time, when the viewer asks (GET /photos/{id}?albumId=).
    expect(photo!.previewUrl).toBeNull();
  });

  test("the owner still sees every photo with own image paths", async () => {
    const { owner, shared, ready } = await setup();

    const page = photoPageSchema.parse(
      (await api(owner, "GET", `/albums/${shared.albumId}/photos`)).body,
    );
    expect(page.items.map((p) => p.status).sort()).toEqual(["failed", "pending", "ready"]);
    // Stable path, no signature: the owner's own media cookie covers it.
    expect(page.items.find((p) => p.photoId === ready.photoId)?.thumbUrl).toBe(
      `/users/${owner}/thumbs/${ready.photoId}.jpg`,
    );
  });

  test("other users, unshared albums and revoked shares → 404", async () => {
    const { owner, friend, shared, hidden } = await setup();

    expect((await api(newUserId(), "GET", `/albums/${shared.albumId}/photos`)).status).toBe(404);
    expect((await api(friend, "GET", `/albums/${hidden.albumId}/photos`)).status).toBe(404);

    await repos.shares.delete(shared.albumId, friend);
    expect((await api(friend, "GET", `/albums/${shared.albumId}/photos`)).status).toBe(404);
    expect((await api(owner, "GET", `/albums/${shared.albumId}/photos`)).status).toBe(200);
  });

  test("an album deleted by its owner → 404", async () => {
    const { owner, friend, shared } = await setup();
    await repos.albums.delete(owner, shared.albumId);
    expect((await api(friend, "GET", `/albums/${shared.albumId}/photos`)).status).toBe(404);
  });
});

describe("GET /photos/{photoId}/download-url?albumId= as a share recipient (FR-DL-1)", () => {
  test("a ready photo in the shared album → the owner's original under its file name", async () => {
    const { friend, shared, ready } = await setup();

    const res = await api(friend, "GET", downloadPath(ready.photoId, shared.albumId));

    expect(res.status).toBe(200);
    downloadUrlResponseSchema.parse(res.body);
    expect(downloads).toEqual([{ key: ready.originalKey, fileName: ready.fileName }]);
  });

  test("without albumId the photo isn't found: recipients reach it only through the album", async () => {
    const { friend, ready } = await setup();
    expect((await api(friend, "GET", downloadPath(ready.photoId))).status).toBe(404);
  });

  test("a photo of the owner that isn't in the shared album → 404", async () => {
    const { friend, shared, hidden, privatePhoto } = await setup();

    // Naming the shared album doesn't unlock the owner's other photos…
    expect(
      (await api(friend, "GET", downloadPath(privatePhoto.photoId, shared.albumId))).status,
    ).toBe(404);
    // …and naming the album that does contain it doesn't help without a share.
    expect(
      (await api(friend, "GET", downloadPath(privatePhoto.photoId, hidden.albumId))).status,
    ).toBe(404);
    expect(downloads).toEqual([]);
  });

  test("pending and failed photos aren't visible to recipients → 404", async () => {
    const { friend, shared, pending, failed } = await setup();
    for (const photo of [pending, failed]) {
      expect((await api(friend, "GET", downloadPath(photo.photoId, shared.albumId))).status).toBe(
        404,
      );
    }
  });

  test("access ends with the share, the membership or the photo", async () => {
    const { owner, friend, shared, ready } = await setup();
    const path = downloadPath(ready.photoId, shared.albumId);
    expect((await api(friend, "GET", path)).status).toBe(200);

    await repos.albums.removePhoto(owner, shared.albumId, ready.photoId);
    expect((await api(friend, "GET", path)).status).toBe(404);

    await repos.albums.addPhotos(owner, shared.albumId, [ready.photoId], nextIso());
    expect((await api(friend, "GET", path)).status).toBe(200);
    await repos.shares.delete(shared.albumId, friend);
    expect((await api(friend, "GET", path)).status).toBe(404);
  });

  test("strangers get 404 even with the right album ID", async () => {
    const { shared, ready } = await setup();
    expect(
      (await api(newUserId(), "GET", downloadPath(ready.photoId, shared.albumId))).status,
    ).toBe(404);
  });

  test("the owner can pass albumId too; own photos ignore it", async () => {
    const { owner, shared, hidden, ready } = await setup();
    expect((await api(owner, "GET", downloadPath(ready.photoId, shared.albumId))).status).toBe(200);
    expect((await api(owner, "GET", downloadPath(ready.photoId, hidden.albumId))).status).toBe(200);
  });

  test("invalid albumId → 400", async () => {
    const { friend, ready } = await setup();
    expect((await api(friend, "GET", downloadPath(ready.photoId, "nope"))).status).toBe(400);
  });
});

describe("recipients stay read-only (FR-SHR-4)", () => {
  test("can't see, delete or re-album the owner's photos through other routes", async () => {
    const { owner, friend, shared, ready } = await setup();

    expect((await api(friend, "GET", `/photos/${ready.photoId}`)).status).toBe(404);
    expect((await api(friend, "DELETE", `/photos/${ready.photoId}`)).status).toBe(404);
    expect(
      (await api(friend, "DELETE", `/albums/${shared.albumId}/photos/${ready.photoId}`)).status,
    ).toBe(404);
    // Adding the owner's photo to the recipient's own album fails: it isn't their photo.
    const mine = await repos.albums.create({
      ownerId: friend,
      albumId: newId(),
      name: "Mine",
      createdAt: nextIso(),
    });
    expect(
      (await api(friend, "POST", `/albums/${mine.albumId}/photos`, { photoIds: [ready.photoId] }))
        .status,
    ).toBe(404);
    // A recipient's own gallery doesn't include shared photos.
    expect(photoPageSchema.parse((await api(friend, "GET", "/photos")).body).items).toEqual([]);

    expect(await repos.photos.get(owner, ready.photoId)).not.toBeNull();
    expect(await repos.albums.hasPhoto(shared.albumId, ready.photoId)).toBe(true);
  });
});
