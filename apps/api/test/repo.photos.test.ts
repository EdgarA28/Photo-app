/** Photos repository against DynamoDB Local (task 5.3, spec §8.2). */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, test } from "vitest";
import type { Db, PhotoRecord, Repositories } from "../src/repo";
import { createPending, createTestRepos, markReady, newPhoto, newUserId } from "./helpers";

let db: Db;
let repos: Repositories;
beforeAll(async () => {
  ({ db, repos } = await createTestRepos());
});

async function rawItem(key: Record<string, string>) {
  return (await db.client.send(new GetCommand({ TableName: db.table, Key: key }))).Item;
}

describe("createPending", () => {
  test("writes a pending item listed by upload time, without counting usage", async () => {
    const userId = newUserId();
    const input = newPhoto(userId);
    const created = await createPending(repos, input);

    expect(created).toMatchObject({ status: "pending", takenAt: input.uploadedAt });
    expect(await repos.photos.get(userId, input.photoId)).toEqual(created);
    // Contract with the thumbnail Lambda (ARCHITECTURE.md §8.2).
    expect(await rawItem({ PK: `USER#${userId}`, SK: `PHOTO#${input.photoId}` })).toMatchObject({
      GSI1PK: `USER#${userId}`,
      GSI1SK: `TAKEN#${input.uploadedAt}#${input.photoId}`,
      entity: "photo",
    });
    // Only the reservation: nothing is counted until the thumbnail Lambda is done.
    expect(await repos.usage.get(userId)).toEqual({
      bytesUsed: 0,
      photoCount: 0,
      bytesReserved: input.sizeBytes,
      quotaBytes: null,
    });
  });

  test("refuses to overwrite an existing photo", async () => {
    const input = newPhoto(newUserId());
    await createPending(repos, input);
    await expect(createPending(repos, input)).rejects.toThrow();
  });
});

describe("createPending quota reservation (FR-UP-7, 5.6b)", () => {
  test("reserves up to the quota exactly, then refuses without writing anything", async () => {
    const userId = newUserId();
    const first = newPhoto(userId, { sizeBytes: 600 });
    const second = newPhoto(userId, { sizeBytes: 400 });
    const third = newPhoto(userId, { sizeBytes: 1 });
    expect(await repos.photos.createPending(first, { quotaBytes: 1000 })).toMatchObject({
      status: "pending",
    });
    expect(await repos.photos.createPending(second, { quotaBytes: 1000 })).toMatchObject({
      status: "pending",
    });
    expect(await repos.photos.createPending(third, { quotaBytes: 1000 })).toBe("quota-exceeded");

    expect(await repos.photos.get(userId, third.photoId)).toBeNull();
    expect(await repos.usage.get(userId)).toMatchObject({ bytesUsed: 0, bytesReserved: 1000 });
  });

  test("a photo larger than the whole quota is refused for a new user", async () => {
    const userId = newUserId();
    const photo = newPhoto(userId, { sizeBytes: 2000 });
    expect(await repos.photos.createPending(photo, { quotaBytes: 1000 })).toBe("quota-exceeded");
    expect(await repos.photos.get(userId, photo.photoId)).toBeNull();
    expect(await repos.usage.get(userId)).toMatchObject({ bytesReserved: 0 });
  });

  test("parallel requests can't overshoot: exactly as many as fit succeed", async () => {
    const userId = newUserId();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repos.photos.createPending(newPhoto(userId, { sizeBytes: 300 }), { quotaBytes: 1000 }),
      ),
    );
    expect(results.filter((r) => r !== "quota-exceeded")).toHaveLength(3);
    expect(await repos.usage.get(userId)).toMatchObject({ bytesReserved: 900 });
  });
});

describe("tenant isolation", () => {
  test("another user's photo is invisible to get, getMany, list and delete", async () => {
    const owner = newUserId();
    const intruder = newUserId();
    const photo = newPhoto(owner);
    await createPending(repos, photo);

    expect(await repos.photos.get(intruder, photo.photoId)).toBeNull();
    expect(await repos.photos.getMany(intruder, [photo.photoId])).toEqual([]);
    expect((await repos.photos.list(intruder, { sort: "taken-desc", limit: 10 })).items).toEqual(
      [],
    );
    expect(await repos.photos.delete(intruder, photo.photoId)).toBeNull();
    expect(await repos.photos.get(owner, photo.photoId)).not.toBeNull();
  });
});

describe("list (gallery, GSI1)", () => {
  test("orders by date taken, pages with an opaque cursor, no empty last page", async () => {
    const userId = newUserId();
    const photos: PhotoRecord[] = [];
    for (let i = 0; i < 5; i++) photos.push(await createPending(repos, newPhoto(userId)));
    // The oldest upload turns out to be the newest photo once its EXIF date is known.
    await markReady(db, userId, photos[0]!.photoId, 500, "2030-01-01T00:00:00.000Z");

    const ids = (items: { photoId: string }[]) => items.map((p) => p.photoId);
    const first = await repos.photos.list(userId, { sort: "taken-desc", limit: 2 });
    const second = await repos.photos.list(userId, {
      sort: "taken-desc",
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await repos.photos.list(userId, {
      sort: "taken-desc",
      limit: 2,
      cursor: second.nextCursor!,
    });

    expect([...ids(first.items), ...ids(second.items), ...ids(third.items)]).toEqual([
      photos[0]!.photoId,
      photos[4]!.photoId,
      photos[3]!.photoId,
      photos[2]!.photoId,
      photos[1]!.photoId,
    ]);
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const asc = await repos.photos.list(userId, { sort: "taken-asc", limit: 10 });
    expect(ids(asc.items)).toEqual([1, 2, 3, 4, 0].map((i) => photos[i]!.photoId));
    expect(asc.nextCursor).toBeNull();
    expect(asc.items[0]).not.toHaveProperty("PK");
  });

  test("exactly `limit` items gives no cursor", async () => {
    const userId = newUserId();
    for (let i = 0; i < 3; i++) await createPending(repos, newPhoto(userId));
    expect(
      (await repos.photos.list(userId, { sort: "taken-desc", limit: 3 })).nextCursor,
    ).toBeNull();
  });

  test("a cursor from another user's gallery is rejected", async () => {
    const a = newUserId();
    for (let i = 0; i < 2; i++) await createPending(repos, newPhoto(a));
    const { nextCursor } = await repos.photos.list(a, { sort: "taken-desc", limit: 1 });
    await expect(
      repos.photos.list(newUserId(), { sort: "taken-desc", limit: 1, cursor: nextCursor! }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("delete", () => {
  test("ready photo: removes item and decrements usage", async () => {
    const userId = newUserId();
    const a = newPhoto(userId);
    const b = newPhoto(userId);
    await createPending(repos, a);
    await createPending(repos, b);
    await markReady(db, userId, a.photoId, 300, a.uploadedAt);
    await markReady(db, userId, b.photoId, 700, b.uploadedAt);

    const deleted = await repos.photos.delete(userId, a.photoId);

    expect(deleted).toMatchObject({ photoId: a.photoId, status: "ready", sizeBytes: 300 });
    expect(await repos.photos.get(userId, a.photoId)).toBeNull();
    // The Lambda moved each reservation to the actual size; the delete released 300 of it.
    expect(await repos.usage.get(userId)).toMatchObject({
      bytesUsed: 700,
      photoCount: 1,
      bytesReserved: 700,
    });
    expect(await repos.photos.delete(userId, a.photoId)).toBeNull();
  });

  test("pending photo: releases its reservation, counted usage untouched", async () => {
    const userId = newUserId();
    const ready = newPhoto(userId);
    const pending = newPhoto(userId);
    await createPending(repos, ready);
    await markReady(db, userId, ready.photoId, 400, ready.uploadedAt);
    await createPending(repos, pending);

    await repos.photos.delete(userId, pending.photoId);

    expect(await repos.usage.get(userId)).toMatchObject({
      bytesUsed: 400,
      photoCount: 1,
      bytesReserved: 400,
    });
  });

  test("removes album memberships and fixes counts and covers", async () => {
    const userId = newUserId();
    const photo = newPhoto(userId);
    const other = newPhoto(userId);
    await createPending(repos, photo);
    await createPending(repos, other);
    const albumIds = ["01JAAAAAAAAAAAAAAAAAAAAAA1", "01JAAAAAAAAAAAAAAAAAAAAAA2"];
    for (const albumId of albumIds) {
      await repos.albums.create({
        ownerId: userId,
        albumId,
        name: albumId,
        createdAt: photo.uploadedAt,
      });
      await repos.albums.addPhotos(
        userId,
        albumId,
        [photo.photoId, other.photoId],
        photo.uploadedAt,
      );
    }
    await repos.albums.update(userId, albumIds[0]!, { coverPhotoId: photo.photoId });

    await repos.photos.delete(userId, photo.photoId);

    for (const albumId of albumIds) {
      const album = await repos.albums.get(userId, albumId);
      expect(album?.photoCount).toBe(1);
      expect(album?.coverPhotoId).toBeUndefined();
      expect(await repos.albums.hasPhoto(albumId, photo.photoId)).toBe(false);
      expect(await repos.albums.hasPhoto(albumId, other.photoId)).toBe(true);
    }
  });
});
