/** Album routes (5.10, 5.11) on DynamoDB Local: CRUD, album photos, 404 for other users. */
import {
  albumListSchema,
  albumSchema,
  apiErrorSchema,
  newId,
  photoPageSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Db, Repositories } from "../src/repo";
import { createTestApi, markReady, newPhoto, newUserId } from "./helpers";

let db: Db;
let repos: Repositories;
let api: Awaited<ReturnType<typeof createTestApi>>["api"];
beforeAll(async () => {
  ({ db, repos, api } = await createTestApi());
});

function errorCode(body: unknown) {
  return apiErrorSchema.parse(body).error.code;
}

async function upload(userId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++)
    ids.push((await repos.photos.createPending(newPhoto(userId))).photoId);
  return ids;
}

async function createAlbum(userId: string, name = "Holidays") {
  const { status, body } = await api(userId, "POST", "/albums", { name });
  expect(status).toBe(201);
  return albumSchema.parse(body);
}

async function albumPhotos(userId: string, albumId: string, query = "") {
  return api(userId, "GET", `/albums/${albumId}/photos${query}`);
}

describe("albums CRUD (FR-ALB-1)", () => {
  test("create trims the name and starts empty", async () => {
    const user = newUserId();
    const album = await createAlbum(user, "  Summer  ");
    expect(album).toMatchObject({
      name: "Summer",
      coverPhotoId: null,
      coverThumbUrl: null,
      photoCount: 0,
    });
  });

  test("create rejects empty names", async () => {
    const { status, body } = await api(newUserId(), "POST", "/albums", { name: " " });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe("VALIDATION_ERROR");
  });

  test("list shows own albums with cover thumbnails once the cover is ready", async () => {
    const user = newUserId();
    const a = await createAlbum(user, "A");
    const b = await createAlbum(user, "B");
    const [readyPhoto, pendingPhoto] = await upload(user, 2);
    await markReady(db, user, readyPhoto!, 100, "2025-01-01T00:00:00.000Z");
    await api(user, "POST", `/albums/${a.albumId}/photos`, { photoIds: [readyPhoto] });
    await api(user, "POST", `/albums/${b.albumId}/photos`, { photoIds: [pendingPhoto] });
    await api(user, "PATCH", `/albums/${a.albumId}`, { coverPhotoId: readyPhoto });
    await api(user, "PATCH", `/albums/${b.albumId}`, { coverPhotoId: pendingPhoto });

    const { status, body } = await api(user, "GET", "/albums");
    expect(status).toBe(200);
    expect(albumListSchema.parse(body).items).toEqual([
      {
        ...a,
        photoCount: 1,
        coverPhotoId: readyPhoto,
        coverThumbUrl: `/users/${user}/thumbs/${readyPhoto}.jpg`,
      },
      { ...b, photoCount: 1, coverPhotoId: pendingPhoto, coverThumbUrl: null },
    ]);
    expect(albumListSchema.parse((await api(newUserId(), "GET", "/albums")).body).items).toEqual(
      [],
    );
  });

  test("patch renames, sets and clears the cover", async () => {
    const user = newUserId();
    const album = await createAlbum(user);
    const [photoId] = await upload(user, 1);
    await api(user, "POST", `/albums/${album.albumId}/photos`, { photoIds: [photoId] });

    const renamed = await api(user, "PATCH", `/albums/${album.albumId}`, {
      name: "Renamed",
      coverPhotoId: photoId,
    });
    expect(renamed.status).toBe(200);
    expect(albumSchema.parse(renamed.body)).toMatchObject({
      name: "Renamed",
      coverPhotoId: photoId,
      coverThumbUrl: null, // still pending
    });

    const cleared = await api(user, "PATCH", `/albums/${album.albumId}`, { coverPhotoId: null });
    expect(albumSchema.parse(cleared.body)).toMatchObject({ name: "Renamed", coverPhotoId: null });
  });

  test("patch rejects a cover that is not in the album, and empty bodies", async () => {
    const user = newUserId();
    const album = await createAlbum(user);
    const [outsider] = await upload(user, 1);
    const notMember = await api(user, "PATCH", `/albums/${album.albumId}`, {
      coverPhotoId: outsider,
    });
    expect(notMember.status).toBe(400);
    expect(errorCode(notMember.body)).toBe("VALIDATION_ERROR");
    expect((await api(user, "PATCH", `/albums/${album.albumId}`, {})).status).toBe(400);
  });

  test("delete removes the album but keeps its photos", async () => {
    const user = newUserId();
    const album = await createAlbum(user);
    const [photoId] = await upload(user, 1);
    await api(user, "POST", `/albums/${album.albumId}/photos`, { photoIds: [photoId] });

    expect(await api(user, "DELETE", `/albums/${album.albumId}`)).toEqual({
      status: 204,
      body: null,
    });
    expect((await api(user, "DELETE", `/albums/${album.albumId}`)).status).toBe(404);
    expect((await albumPhotos(user, album.albumId)).status).toBe(404);
    expect((await api(user, "GET", `/photos/${photoId}`)).status).toBe(200);
  });
});

describe("album photos (FR-ALB-2)", () => {
  test("add, list in upload order, re-add is a no-op, remove", async () => {
    const user = newUserId();
    const album = await createAlbum(user);
    const [p1, p2, p3] = await upload(user, 3);

    const added = await api(user, "POST", `/albums/${album.albumId}/photos`, {
      photoIds: [p3, p1, p3],
    });
    expect(added).toEqual({ status: 204, body: null });
    expect(
      (await api(user, "POST", `/albums/${album.albumId}/photos`, { photoIds: [p1, p2] })).status,
    ).toBe(204);

    const list = photoPageSchema.parse((await albumPhotos(user, album.albumId)).body);
    expect(list.items.map((p) => p.photoId)).toEqual([p1, p2, p3]);
    expect(list.nextCursor).toBeNull();
    expect((await repos.albums.get(user, album.albumId))?.photoCount).toBe(3);

    expect(await api(user, "DELETE", `/albums/${album.albumId}/photos/${p2}`)).toEqual({
      status: 204,
      body: null,
    });
    expect((await api(user, "DELETE", `/albums/${album.albumId}/photos/${p2}`)).status).toBe(404);
    const after = photoPageSchema.parse((await albumPhotos(user, album.albumId)).body);
    expect(after.items.map((p) => p.photoId)).toEqual([p1, p3]);
    // The photo itself stays.
    expect((await api(user, "GET", `/photos/${p2}`)).status).toBe(200);
  });

  test("paginates with a cursor", async () => {
    const user = newUserId();
    const album = await createAlbum(user);
    const ids = await upload(user, 5);
    await api(user, "POST", `/albums/${album.albumId}/photos`, { photoIds: ids });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = photoPageSchema.parse((await albumPhotos(user, album.albumId, query)).body);
      seen.push(...page.items.map((p) => p.photoId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
  });

  test("an unknown photo makes the whole add 404 and adds nothing", async () => {
    const user = newUserId();
    const album = await createAlbum(user);
    const [mine] = await upload(user, 1);
    const { status, body } = await api(user, "POST", `/albums/${album.albumId}/photos`, {
      photoIds: [mine, newId()],
    });
    expect(status).toBe(404);
    expect(apiErrorSchema.parse(body).error.message).toBe("Photo not found");
    expect(photoPageSchema.parse((await albumPhotos(user, album.albumId)).body).items).toEqual([]);
  });

  test("400 for malformed IDs and empty or oversized lists", async () => {
    const user = newUserId();
    const album = await createAlbum(user);
    for (const photoIds of [[], ["nope"], Array.from({ length: 101 }, () => newId())]) {
      const { status } = await api(user, "POST", `/albums/${album.albumId}/photos`, { photoIds });
      expect(status).toBe(400);
    }
  });
});

describe("other users' albums and photos are 404 (NFR-SEC-2)", () => {
  test("every album route", async () => {
    const owner = newUserId();
    const intruder = newUserId();
    const album = await createAlbum(owner);
    const [ownerPhoto] = await upload(owner, 1);
    const [intruderPhoto] = await upload(intruder, 1);
    await api(owner, "POST", `/albums/${album.albumId}/photos`, { photoIds: [ownerPhoto] });
    await api(owner, "PATCH", `/albums/${album.albumId}`, { coverPhotoId: ownerPhoto });

    const path = `/albums/${album.albumId}`;
    const missingPath = `/albums/${newId()}`;
    const requests: [string, string, unknown?][] = [
      ["PATCH", path, { name: "pwned" }],
      ["PATCH", path, { coverPhotoId: ownerPhoto }],
      ["DELETE", path],
      ["GET", `${path}/photos`],
      ["POST", `${path}/photos`, { photoIds: [intruderPhoto] }],
      ["DELETE", `${path}/photos/${ownerPhoto}`],
    ];
    for (const [method, target, body] of requests) {
      const foreign = await api(intruder, method, target, body);
      const missing = await api(intruder, method, target.replace(path, missingPath), body);
      expect(foreign.status, `${method} ${target}`).toBe(404);
      expect(foreign, `${method} ${target}`).toEqual(missing);
    }
    // Adding someone else's photo to your own album is 404 too.
    const own = await createAlbum(intruder);
    const borrowed = await api(intruder, "POST", `/albums/${own.albumId}/photos`, {
      photoIds: [ownerPhoto],
    });
    expect(borrowed.status).toBe(404);

    // Nothing changed for the owner.
    expect(await repos.albums.get(owner, album.albumId)).toMatchObject({
      name: "Holidays",
      photoCount: 1,
      coverPhotoId: ownerPhoto,
    });
    const ownerList = photoPageSchema.parse((await albumPhotos(owner, album.albumId)).body);
    expect(ownerList.items.map((p) => p.photoId)).toEqual([ownerPhoto]);
  });
});
