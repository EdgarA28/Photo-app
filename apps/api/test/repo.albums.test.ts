/** Albums, memberships, shares and usage repositories against DynamoDB Local (task 5.3). */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { newId } from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Db, Repositories } from "../src/repo";
import { createTestRepos, newPhoto, newUserId, nextIso } from "./helpers";

let db: Db;
let repos: Repositories;
beforeAll(async () => {
  ({ db, repos } = await createTestRepos());
});

async function album(ownerId: string, name = "Holidays") {
  return repos.albums.create({ ownerId, albumId: newId(), name, createdAt: nextIso() });
}

async function photos(userId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++)
    ids.push((await repos.photos.createPending(newPhoto(userId))).photoId);
  return ids;
}

describe("albums", () => {
  test("create, get, list", async () => {
    const owner = newUserId();
    const a = await album(owner, "A");
    const b = await album(owner, "B");
    expect(a).toMatchObject({ ownerId: owner, name: "A", photoCount: 0 });
    expect(await repos.albums.get(owner, a.albumId)).toEqual(a);
    expect((await repos.albums.list(owner)).map((x) => x.name)).toEqual(["A", "B"]);
    // Albums must not leak into the photo gallery query (same PK, different SK prefix).
    expect((await repos.photos.list(owner, { sort: "taken-desc", limit: 10 })).items).toEqual([]);
    expect(b.albumId).not.toBe(a.albumId);
  });

  test("other users cannot get, list, update, delete or add to an album", async () => {
    const owner = newUserId();
    const intruder = newUserId();
    const a = await album(owner);
    const [intruderPhoto] = await photos(intruder, 1);

    expect(await repos.albums.get(intruder, a.albumId)).toBeNull();
    expect(await repos.albums.list(intruder)).toEqual([]);
    expect(await repos.albums.update(intruder, a.albumId, { name: "pwned" })).toBeNull();
    expect(await repos.albums.delete(intruder, a.albumId)).toBe(false);
    const results = await repos.albums.addPhotos(intruder, a.albumId, [intruderPhoto!], nextIso());
    expect(results.get(intruderPhoto!)).toBe("album-not-found");
    expect(await repos.albums.get(owner, a.albumId)).toMatchObject({
      name: "Holidays",
      photoCount: 0,
    });
    // The failed transaction must not have created a stub album under the intruder.
    expect(await repos.albums.list(intruder)).toEqual([]);
  });

  test("update renames, sets and clears the cover", async () => {
    const owner = newUserId();
    const a = await album(owner);
    const [p1, outsider] = await photos(owner, 2);
    await repos.albums.addPhotos(owner, a.albumId, [p1!], nextIso());

    expect(
      await repos.albums.update(owner, a.albumId, { name: "Renamed", coverPhotoId: p1! }),
    ).toMatchObject({
      name: "Renamed",
      coverPhotoId: p1,
    });
    expect(await repos.albums.update(owner, a.albumId, { coverPhotoId: outsider! })).toBe(
      "cover-not-in-album",
    );
    const cleared = await repos.albums.update(owner, a.albumId, { coverPhotoId: null });
    expect(cleared).toMatchObject({ name: "Renamed" });
    expect(cleared).not.toHaveProperty("coverPhotoId");
    expect(await repos.albums.update(owner, newId(), { name: "x" })).toBeNull();
  });
});

describe("memberships", () => {
  test("add is idempotent and reports missing / foreign photos", async () => {
    const owner = newUserId();
    const a = await album(owner);
    const [p1, p2] = await photos(owner, 2);
    const [foreign] = await photos(newUserId(), 1);
    const missing = newId();

    const first = await repos.albums.addPhotos(
      owner,
      a.albumId,
      [p1!, p2!, p1!, foreign!, missing],
      nextIso(),
    );
    expect(Object.fromEntries(first)).toEqual({
      [p1!]: "added",
      [p2!]: "added",
      [foreign!]: "photo-not-found",
      [missing]: "photo-not-found",
    });
    const second = await repos.albums.addPhotos(owner, a.albumId, [p1!], nextIso());
    expect(second.get(p1!)).toBe("already-member");

    expect((await repos.albums.get(owner, a.albumId))?.photoCount).toBe(2);
    expect((await repos.photos.get(owner, p1!))?.albumIds).toEqual(new Set([a.albumId]));
    // No stub photo items were created for the foreign / missing IDs.
    expect(await repos.photos.get(owner, foreign!)).toBeNull();
    expect(await repos.photos.get(owner, missing)).toBeNull();
  });

  test("listMemberships pages in upload order", async () => {
    const owner = newUserId();
    const a = await album(owner);
    const ids = await photos(owner, 3);
    await repos.albums.addPhotos(owner, a.albumId, ids, nextIso());

    const first = await repos.albums.listMemberships(a.albumId, { limit: 2 });
    const second = await repos.albums.listMemberships(a.albumId, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect([...first.items, ...second.items].map((m) => m.photoId)).toEqual(ids);
    expect(first.items[0]).toMatchObject({ albumId: a.albumId, ownerId: owner });
    expect(second.nextCursor).toBeNull();
  });

  test("remove fixes count, cover and the photo's albumIds; second remove is false", async () => {
    const owner = newUserId();
    const a = await album(owner);
    const [p1, p2] = await photos(owner, 2);
    await repos.albums.addPhotos(owner, a.albumId, [p1!, p2!], nextIso());
    await repos.albums.update(owner, a.albumId, { coverPhotoId: p1! });

    expect(await repos.albums.removePhoto(owner, a.albumId, p1!)).toBe(true);
    expect(await repos.albums.removePhoto(owner, a.albumId, p1!)).toBe(false);

    const after = await repos.albums.get(owner, a.albumId);
    expect(after?.photoCount).toBe(1);
    expect(after?.coverPhotoId).toBeUndefined();
    expect((await repos.photos.get(owner, p1!))?.albumIds).toBeUndefined();
    expect(await repos.albums.hasPhoto(a.albumId, p2!)).toBe(true);
  });

  test("another user cannot remove photos from an album that isn't theirs", async () => {
    const owner = newUserId();
    const intruder = newUserId();
    const a = await album(owner);
    const [p1] = await photos(owner, 1);
    const [intruderPhoto] = await photos(intruder, 1);
    await repos.albums.addPhotos(owner, a.albumId, [p1!], nextIso());

    expect(await repos.albums.removePhoto(intruder, a.albumId, p1!)).toBe(false);
    expect(await repos.albums.removePhoto(intruder, a.albumId, intruderPhoto!)).toBe(false);

    expect(await repos.albums.hasPhoto(a.albumId, p1!)).toBe(true);
    expect((await repos.albums.get(owner, a.albumId))?.photoCount).toBe(1);
    expect((await repos.photos.get(owner, p1!))?.albumIds).toEqual(new Set([a.albumId]));
  });

  test("remove still works if the photo item is already gone", async () => {
    const owner = newUserId();
    const a = await album(owner);
    const photoId = newId();
    // A dangling membership, e.g. left behind by an interrupted cleanup.
    await db.client.send(
      new PutCommand({
        TableName: db.table,
        Item: {
          PK: `ALBUM#${a.albumId}`,
          SK: `PHOTO#${photoId}`,
          albumId: a.albumId,
          photoId,
          ownerId: owner,
        },
      }),
    );
    expect(await repos.albums.removePhoto(owner, a.albumId, photoId)).toBe(true);
    expect(await repos.albums.hasPhoto(a.albumId, photoId)).toBe(false);
    expect(await repos.photos.get(owner, photoId)).toBeNull();
  });
});

describe("album delete", () => {
  test("removes memberships and shares, keeps the photos", async () => {
    const owner = newUserId();
    const friend = newUserId();
    const a = await album(owner);
    const keep = await album(owner, "Keep");
    const [p1] = await photos(owner, 1);
    await repos.albums.addPhotos(owner, a.albumId, [p1!], nextIso());
    await repos.albums.addPhotos(owner, keep.albumId, [p1!], nextIso());
    await repos.shares.put({
      albumId: a.albumId,
      ownerId: owner,
      userId: friend,
      email: "f@example.com",
      sharedAt: nextIso(),
    });

    expect(await repos.albums.delete(owner, a.albumId)).toBe(true);

    expect(await repos.albums.get(owner, a.albumId)).toBeNull();
    expect(await repos.albums.hasPhoto(a.albumId, p1!)).toBe(false);
    expect(await repos.shares.listForAlbum(a.albumId)).toEqual([]);
    expect((await repos.shares.listForRecipient(friend, { limit: 10 })).items).toEqual([]);
    expect((await repos.photos.get(owner, p1!))?.albumIds).toEqual(new Set([keep.albumId]));
    expect(await repos.albums.delete(owner, a.albumId)).toBe(false);
  });
});

describe("shares", () => {
  test("put, get, list both ways, revoke", async () => {
    const owner = newUserId();
    const friend = newUserId();
    const a = await album(owner, "A");
    const b = await album(owner, "B");
    const share = {
      albumId: a.albumId,
      ownerId: owner,
      userId: friend,
      email: "f@example.com",
      sharedAt: nextIso(),
    };
    await repos.shares.put(share);
    await repos.shares.put(share); // Idempotent.
    await repos.shares.put({ ...share, albumId: b.albumId });

    expect(await repos.shares.get(a.albumId, friend)).toEqual(share);
    expect(await repos.shares.get(a.albumId, owner)).toBeNull();
    expect(await repos.shares.listForAlbum(a.albumId)).toEqual([share]);

    const first = await repos.shares.listForRecipient(friend, { limit: 1 });
    const second = await repos.shares.listForRecipient(friend, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect([...first.items, ...second.items].map((s) => s.albumId).sort()).toEqual(
      [a.albumId, b.albumId].sort(),
    );
    expect(second.nextCursor).toBeNull();
    // Shares don't show up in the recipient's own gallery or albums.
    expect((await repos.photos.list(friend, { sort: "taken-desc", limit: 10 })).items).toEqual([]);
    expect(await repos.albums.list(friend)).toEqual([]);

    expect(await repos.shares.delete(a.albumId, friend)).toBe(true);
    expect(await repos.shares.delete(a.albumId, friend)).toBe(false);
    expect(await repos.shares.get(a.albumId, friend)).toBeNull();
  });
});

describe("usage", () => {
  test("defaults to zero and reads a per-user quota override", async () => {
    const userId = newUserId();
    expect(await repos.usage.get(userId)).toEqual({
      bytesUsed: 0,
      photoCount: 0,
      quotaBytes: null,
    });
    await db.client.send(
      new PutCommand({
        TableName: db.table,
        Item: {
          PK: `USER#${userId}`,
          SK: "USAGE",
          bytesUsed: 10,
          photoCount: 1,
          quotaBytes: 5_000,
        },
      }),
    );
    expect(await repos.usage.get(userId)).toEqual({
      bytesUsed: 10,
      photoCount: 1,
      quotaBytes: 5_000,
    });
  });
});
