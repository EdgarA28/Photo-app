/** The trash (FR-DEL-3): GET /trash, restore, delete forever, empty, and the daily purge. */
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  TRASH_RETENTION_DAYS,
  apiErrorSchema,
  newId,
  photoLocationListSchema,
  photoPageSchema,
  photoSchema,
  placeListSchema,
  previewKey,
  thumbKey,
  trashListSchema,
} from "@photo-app/shared";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyTrash, purgeExpired } from "../src/lib/trash";
import type { Db, Repositories } from "../src/repo";
import {
  BERLIN,
  addPlaces,
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
let deletes: string[][];
let storage: TestApi["storage"];
beforeAll(async () => {
  ({ db, repos, api, deletes, storage } = await createTestApi());
});
beforeEach(() => {
  deletes.length = 0;
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function readyPhoto(userId: string, size = 1000, takenAt = "2025-06-01T12:00:00.000Z") {
  const photo = await createPending(repos, newPhoto(userId, { sizeBytes: size }));
  await markReady(db, userId, photo.photoId, size, takenAt);
  return photo;
}

async function newAlbum(userId: string, name = "Trip") {
  return repos.albums.create({
    ownerId: userId,
    albumId: newId(),
    name,
    createdAt: new Date().toISOString(),
  });
}

async function trash(userId: string) {
  const res = await api(userId, "GET", "/trash");
  expect(res.status).toBe(200);
  return trashListSchema.parse(res.body).items;
}

async function gallery(userId: string) {
  const res = await api(userId, "GET", "/photos");
  return photoPageSchema.parse(res.body).items.map((p) => p.photoId);
}

async function placeItem(userId: string, placeId: string) {
  const out = await db.client.send(
    new GetCommand({ TableName: db.table, Key: { PK: `USER#${userId}`, SK: `PLACE#${placeId}` } }),
  );
  return out.Item;
}

const keysOf = (userId: string, photo: { photoId: string; originalKey: string }) => [
  photo.originalKey,
  thumbKey(userId, photo.photoId),
  previewKey(userId, photo.photoId),
];

describe("GET /trash", () => {
  test("lists own trashed photos, most recently deleted first, with their purge date", async () => {
    const user = newUserId();
    const first = await readyPhoto(user);
    const second = await readyPhoto(user);
    await readyPhoto(user); // not deleted

    const before = Date.now();
    await api(user, "DELETE", `/photos/${first.photoId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await api(user, "DELETE", `/photos/${second.photoId}`);

    const items = await trash(user);
    expect(items.map((p) => p.photoId)).toEqual([second.photoId, first.photoId]);
    const { trashedAt, purgeAt, thumbUrl } = items[0]!;
    expect(Date.parse(trashedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(purgeAt!) - Date.parse(trashedAt!)).toBe(TRASH_RETENTION_DAYS * DAY_MS);
    expect(thumbUrl).toBe(`/${thumbKey(user, second.photoId)}`);
    // Other users' trash is not mine.
    expect(await trash(newUserId())).toEqual([]);
  });

  test("a trashed photo is still the owner's to view, and nobody else's", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);
    await api(user, "DELETE", `/photos/${photo.photoId}`);

    const own = await api(user, "GET", `/photos/${photo.photoId}`);
    expect(own.status).toBe(200);
    expect(photoSchema.parse(own.body).trashedAt).not.toBeNull();
    expect((await api(newUserId(), "GET", `/photos/${photo.photoId}`)).status).toBe(404);
  });

  test("pending uploads are deleted at once, never trashed", async () => {
    const user = newUserId();
    const photo = await createPending(repos, newPhoto(user));
    expect((await api(user, "DELETE", `/photos/${photo.photoId}`)).status).toBe(204);
    expect(deletes).toEqual([keysOf(user, photo)]);
    expect(await trash(user)).toEqual([]);
  });
});

describe("trashed photos are hidden everywhere else", () => {
  test("albums, shared albums, places and the map; can't be added to an album", async () => {
    const owner = newUserId();
    const friend = newUserId();
    const photo = await readyPhoto(owner);
    await addPlaces(db, owner, photo.photoId, BERLIN);
    const album = await newAlbum(owner);
    await repos.albums.addPhotos(owner, album.albumId, [photo.photoId], "now");
    await repos.shares.create({
      albumId: album.albumId,
      ownerId: owner,
      userId: friend,
      email: "f@example.com",
      sharedAt: "now",
    });
    await repos.shares.accept(album.albumId, friend, "now");

    await api(owner, "DELETE", `/photos/${photo.photoId}`);

    const albumPage = await api(owner, "GET", `/albums/${album.albumId}/photos`);
    expect(photoPageSchema.parse(albumPage.body).items).toEqual([]);
    const sharedPage = await api(friend, "GET", `/albums/${album.albumId}/photos`);
    expect(photoPageSchema.parse(sharedPage.body).items).toEqual([]);
    const sharedPhoto = await api(
      friend,
      "GET",
      `/photos/${photo.photoId}?albumId=${album.albumId}`,
    );
    expect(sharedPhoto.status).toBe(404);

    expect(placeListSchema.parse((await api(owner, "GET", "/places")).body).items).toEqual([]);
    expect((await api(owner, "GET", `/places/${BERLIN[0]!.placeId}/photos`)).status).toBe(404);
    const map = photoLocationListSchema.parse((await api(owner, "GET", "/places/map")).body);
    expect(map.items).toEqual([]);

    const other = await newAlbum(owner, "Other");
    const add = await api(owner, "POST", `/albums/${other.albumId}/photos`, {
      photoIds: [photo.photoId],
    });
    expect(add.status).toBe(404);
  });
});

describe("POST /trash/{photoId}/restore", () => {
  test("back in the gallery, its places and the albums that still exist", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);
    await addPlaces(db, user, photo.photoId, BERLIN);
    const kept = await newAlbum(user, "Kept");
    const removed = await newAlbum(user, "Removed");
    await repos.albums.addPhotos(user, kept.albumId, [photo.photoId], "now");
    await repos.albums.addPhotos(user, removed.albumId, [photo.photoId], "now");

    await api(user, "DELETE", `/photos/${photo.photoId}`);
    expect((await placeItem(user, BERLIN[0]!.placeId))?.trashedCount).toBe(1);
    await api(user, "DELETE", `/albums/${removed.albumId}`);

    const res = await api(user, "POST", `/trash/${photo.photoId}/restore`);
    expect(res.status).toBe(200);
    expect(photoSchema.parse(res.body)).toMatchObject({ trashedAt: null, purgeAt: null });

    expect(await gallery(user)).toEqual([photo.photoId]);
    expect(await trash(user)).toEqual([]);
    expect(await repos.albums.hasPhoto(kept.albumId, photo.photoId)).toBe(true);
    expect((await repos.albums.get(user, kept.albumId))?.photoCount).toBe(1);
    const places = placeListSchema.parse((await api(user, "GET", "/places")).body).items;
    expect(places.map((p) => [p.placeId, p.photoCount])).toEqual(
      expect.arrayContaining(BERLIN.map((p) => [p.placeId, 1])),
    );
    const placePhotos = await api(user, "GET", `/places/${BERLIN[0]!.placeId}/photos`);
    expect(photoPageSchema.parse(placePhotos.body).items.map((p) => p.photoId)).toEqual([
      photo.photoId,
    ]);
    expect((await placeItem(user, BERLIN[0]!.placeId))?.trashedCount).toBe(0);
  });

  test("not in the trash, someone else's, or unknown → 404", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);
    expect((await api(user, "POST", `/trash/${photo.photoId}/restore`)).status).toBe(404);

    await api(user, "DELETE", `/photos/${photo.photoId}`);
    for (const [as, id] of [
      [newUserId(), photo.photoId],
      [user, newId()],
    ] as const) {
      const res = await api(as, "POST", `/trash/${id}/restore`);
      expect(res.status).toBe(404);
      expect(apiErrorSchema.parse(res.body).error.code).toBe("NOT_FOUND");
    }
    expect(await trash(user)).toHaveLength(1);
  });
});

describe("DELETE /trash/{photoId} and DELETE /trash", () => {
  test("delete forever: files, item, places and usage are gone", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user, 700);
    await readyPhoto(user, 300);
    await addPlaces(db, user, photo.photoId, BERLIN);
    await api(user, "DELETE", `/photos/${photo.photoId}`);

    const res = await api(user, "DELETE", `/trash/${photo.photoId}`);
    expect(res.status).toBe(204);
    expect(deletes).toEqual([keysOf(user, photo)]);
    expect(await repos.photos.get(user, photo.photoId)).toBeNull();
    expect(await placeItem(user, BERLIN[0]!.placeId)).toBeUndefined();
    expect(await repos.usage.get(user)).toMatchObject({
      bytesUsed: 300,
      photoCount: 1,
      bytesReserved: 300,
    });
  });

  test("only photos in the caller's trash: others → 404, untouched", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);
    expect((await api(user, "DELETE", `/trash/${photo.photoId}`)).status).toBe(404);
    await api(user, "DELETE", `/photos/${photo.photoId}`);
    expect((await api(newUserId(), "DELETE", `/trash/${photo.photoId}`)).status).toBe(404);
    expect(deletes).toEqual([]);
    expect(await repos.photos.get(user, photo.photoId)).not.toBeNull();
  });

  test("a place keeps its entry while another photo of it is in the trash", async () => {
    const user = newUserId();
    const a = await readyPhoto(user);
    const b = await readyPhoto(user);
    await addPlaces(db, user, a.photoId, BERLIN);
    await addPlaces(db, user, b.photoId, BERLIN);
    await api(user, "DELETE", `/photos/${a.photoId}`);
    await api(user, "DELETE", `/photos/${b.photoId}`);

    await api(user, "DELETE", `/trash/${b.photoId}`);
    expect(await placeItem(user, BERLIN[0]!.placeId)).toMatchObject({
      name: "Berlin",
      photoCount: 0,
      trashedCount: 1,
    });

    await api(user, "POST", `/trash/${a.photoId}/restore`);
    const places = placeListSchema.parse((await api(user, "GET", "/places")).body).items;
    expect(places.find((p) => p.placeId === BERLIN[0]!.placeId)).toMatchObject({
      name: "Berlin",
      photoCount: 1,
    });
  });

  test("empty the trash: every own trashed photo, nobody else's", async () => {
    const user = newUserId();
    const other = newUserId();
    const photos = [await readyPhoto(user), await readyPhoto(user), await readyPhoto(user)];
    const kept = await readyPhoto(user);
    const othersPhoto = await readyPhoto(other);
    for (const photo of photos) await api(user, "DELETE", `/photos/${photo.photoId}`);
    await api(other, "DELETE", `/photos/${othersPhoto.photoId}`);

    const res = await api(user, "DELETE", "/trash");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 3, remaining: 0 });
    expect(await trash(user)).toEqual([]);
    expect(await gallery(user)).toEqual([kept.photoId]);
    expect(await repos.usage.get(user)).toMatchObject({ photoCount: 1, bytesUsed: 1000 });
    expect(await trash(other)).toHaveLength(1);
  });

  test("empty the trash survives deletes clashing on Usage (TransactionConflict)", async () => {
    // Emptying deletes several photos in parallel, each updating Usage: DynamoDB cancels the
    // clashing transactions; the trash answered 500 (dev 2026-10-28).
    const user = newUserId();
    const photos = [await readyPhoto(user), await readyPhoto(user), await readyPhoto(user)];
    for (const photo of photos) await api(user, "DELETE", `/photos/${photo.photoId}`);
    const send = db.client.send.bind(db.client);
    let conflicts = 0;
    const spy = vi.spyOn(db.client, "send").mockImplementation(((command: unknown) => {
      if (command instanceof TransactWriteCommand && conflicts < 2) {
        conflicts++;
        return Promise.reject(
          Object.assign(new Error("Transaction cancelled"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }],
          }),
        );
      }
      return send(command as never);
    }) as typeof db.client.send);
    try {
      expect((await api(user, "DELETE", "/trash")).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(conflicts).toBe(2);
    expect(await trash(user)).toEqual([]);
    expect(await repos.usage.get(user)).toMatchObject({ photoCount: 0, bytesUsed: 0 });
  });

  test("a big trash is emptied a few seconds at a time: deleted and remaining", async () => {
    // 534 photos took longer than the API Lambda's 10 s (dev, 2026-11-01).
    const user = newUserId();
    const photos = [];
    for (let i = 0; i < 7; i++) photos.push(await readyPhoto(user));
    for (const photo of photos) await api(user, "DELETE", `/photos/${photo.photoId}`);

    // No time left: one batch (5 at a time) per call, so every call gets somewhere.
    expect(await emptyTrash(repos, storage, user, { budgetMs: 0 })).toEqual({
      deleted: 5,
      remaining: 2,
    });
    expect(await trash(user)).toHaveLength(2);
    expect(await emptyTrash(repos, storage, user, { budgetMs: 0 })).toEqual({
      deleted: 2,
      remaining: 0,
    });
    expect(await trash(user)).toEqual([]);
    expect(await emptyTrash(repos, storage, user)).toEqual({ deleted: 0, remaining: 0 });
    expect(await repos.usage.get(user)).toMatchObject({ photoCount: 0, bytesUsed: 0 });
  });

  test("anonymous → 401, invalid ID → 400", async () => {
    expect((await api(null, "GET", "/trash")).status).toBe(401);
    expect((await api(newUserId(), "DELETE", "/trash/nope")).status).toBe(400);
    expect((await api(newUserId(), "POST", "/trash/nope/restore")).status).toBe(400);
  });
});

describe("purgeExpired (daily purge)", () => {
  test("deletes photos whose 15 days are up, of every user, and leaves the rest", async () => {
    const alice = newUserId();
    const bob = newUserId();
    const old = await readyPhoto(alice, 400);
    const recent = await readyPhoto(alice, 600);
    const bobs = await readyPhoto(bob);
    const now = Date.now();
    await repos.photos.trash(alice, old.photoId, new Date(now - 16 * DAY_MS));
    await repos.photos.trash(alice, recent.photoId, new Date(now - 14 * DAY_MS));
    await repos.photos.trash(bob, bobs.photoId, new Date(now - 15 * DAY_MS - 1000));

    const result = await purgeExpired(repos, storage, new Date(now));

    expect(result).toEqual({ purged: 2, failed: 0 });
    expect(deletes).toEqual(expect.arrayContaining([keysOf(alice, old), keysOf(bob, bobs)]));
    expect(deletes).toHaveLength(2);
    expect(await repos.photos.get(alice, old.photoId)).toBeNull();
    expect(await repos.photos.get(bob, bobs.photoId)).toBeNull();
    expect(await repos.photos.get(alice, recent.photoId)).not.toBeNull();
    expect(await repos.usage.get(alice)).toMatchObject({ photoCount: 1, bytesUsed: 600 });
    expect(await purgeExpired(repos, storage, new Date(now))).toEqual({ purged: 0, failed: 0 });
  });

  test("a photo restored before the purge is left alone", async () => {
    const user = newUserId();
    const photo = await readyPhoto(user);
    const now = Date.now();
    await repos.photos.trash(user, photo.photoId, new Date(now - 20 * DAY_MS));
    await repos.photos.restore(user, photo.photoId, new Date(now));

    expect(await purgeExpired(repos, storage, new Date(now))).toEqual({ purged: 0, failed: 0 });
    expect(await gallery(user)).toEqual([photo.photoId]);
  });
});
