/**
 * Collaborative albums (FR-SHR-11): members who accepted the share add their own photos while
 * the owner lets them ("Members can add photos"); the photos stay theirs.
 */
import {
  albumListSchema,
  albumSchema,
  newId,
  photoPageSchema,
  photoSchema,
  saveSharedPhotosResponseSchema,
  sharedAlbumPageSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
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
beforeAll(async () => {
  ({ db, repos, api } = await createTestApi());
});

async function readyPhoto(userId: string): Promise<PhotoRecord> {
  const photo = await createPending(repos, newPhoto(userId));
  await markReady(db, userId, photo.photoId, 1000, "2025-06-01T12:00:00.000Z");
  return (await repos.photos.get(userId, photo.photoId))!;
}

/**
 * Alice's album with one of her photos, shared with Bob (accepted) and invited Carol; members may
 * add photos unless `membersCanAdd` is false.
 */
async function setup({ membersCanAdd = true } = {}) {
  const alice = newUserId();
  const bob = newUserId();
  const carol = newUserId();
  await repos.usernames.set(bob, `bob_${bob.slice(0, 6)}`, nextIso());
  const album = await repos.albums.create({
    ownerId: alice,
    albumId: newId(),
    name: "Trip",
    createdAt: nextIso(),
  });
  const albumId = album.albumId;
  const alicePhoto = await readyPhoto(alice);
  await repos.albums.addPhotos(alice, albumId, [alicePhoto.photoId], nextIso());
  for (const [userId, status] of [
    [bob, "accepted"],
    [carol, "pending"],
  ] as const) {
    await repos.shares.create({ albumId, ownerId: alice, userId, status, sharedAt: nextIso() });
  }
  if (membersCanAdd) {
    expect((await api(alice, "PATCH", `/albums/${albumId}`, { membersCanAdd: true })).status).toBe(
      200,
    );
  }
  const bobPhoto = await readyPhoto(bob);
  return { alice, bob, carol, albumId, alicePhoto, bobPhoto };
}

const listPhotos = async (userId: string, albumId: string) =>
  photoPageSchema.parse((await api(userId, "GET", `/albums/${albumId}/photos`)).body).items;

const add = (userId: string, albumId: string, photoIds: string[]) =>
  api(userId, "POST", `/albums/${albumId}/photos`, { photoIds });

describe("Members can add photos (switch)", () => {
  test("off by default; the owner turns it on and off; recipients see it", async () => {
    const { alice, bob, albumId } = await setup({ membersCanAdd: false });
    const own = albumListSchema.parse((await api(alice, "GET", "/albums")).body).items;
    expect(own.find((a) => a.albumId === albumId)?.membersCanAdd).toBe(false);

    const on = await api(alice, "PATCH", `/albums/${albumId}`, { membersCanAdd: true });
    expect(albumSchema.parse(on.body).membersCanAdd).toBe(true);
    const shared = sharedAlbumPageSchema.parse((await api(bob, "GET", "/shared-albums")).body);
    expect(shared.items.find((a) => a.albumId === albumId)?.membersCanAdd).toBe(true);

    const off = await api(alice, "PATCH", `/albums/${albumId}`, { membersCanAdd: false });
    expect(albumSchema.parse(off.body).membersCanAdd).toBe(false);
  });

  test("only the owner can change it", async () => {
    const { bob, albumId } = await setup();
    expect((await api(bob, "PATCH", `/albums/${albumId}`, { membersCanAdd: false })).status).toBe(
      404,
    );
  });
});

describe("POST /albums/{albumId}/photos by a member", () => {
  test("adds the member's own photo; everyone sees who added it", async () => {
    const { alice, bob, albumId, alicePhoto, bobPhoto } = await setup();
    expect((await add(bob, albumId, [bobPhoto.photoId])).status).toBe(204);

    // The photo stays Bob's: in his partition, linked to the album.
    expect((await repos.photos.get(bob, bobPhoto.photoId))?.albumIds).toEqual(new Set([albumId]));
    expect((await repos.albums.get(alice, albumId))?.photoCount).toBe(2);

    // Alice sees Bob's photo with a signed URL and his username, without its place.
    const forAlice = await listPhotos(alice, albumId);
    const bobsForAlice = forAlice.find((p) => p.photoId === bobPhoto.photoId)!;
    expect(bobsForAlice).toMatchObject({ ownerId: bob, ownerUsername: `bob_${bob.slice(0, 6)}` });
    expect(bobsForAlice.place).toBeNull();
    verifySignedUrl(bobsForAlice.thumbUrl!, `/users/${bob}/thumbs/${bobPhoto.photoId}.jpg`);
    // Her own one keeps its stable path.
    expect(forAlice.find((p) => p.photoId === alicePhoto.photoId)?.thumbUrl).toBe(
      `/users/${alice}/thumbs/${alicePhoto.photoId}.jpg`,
    );

    // Bob sees his own photo by its stable path, Alice's signed.
    const forBob = await listPhotos(bob, albumId);
    expect(forBob.find((p) => p.photoId === bobPhoto.photoId)?.thumbUrl).toBe(
      `/users/${bob}/thumbs/${bobPhoto.photoId}.jpg`,
    );
    verifySignedUrl(
      forBob.find((p) => p.photoId === alicePhoto.photoId)!.thumbUrl!,
      `/users/${alice}/thumbs/${alicePhoto.photoId}.jpg`,
    );
  });

  test("a member's photo still processing is shown to them only", async () => {
    const { alice, bob, albumId } = await setup();
    const pending = await createPending(repos, newPhoto(bob));
    expect((await add(bob, albumId, [pending.photoId])).status).toBe(204);
    expect((await listPhotos(bob, albumId)).map((p) => p.photoId)).toContain(pending.photoId);
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).not.toContain(pending.photoId);
    expect((await api(alice, "GET", `/photos/${pending.photoId}?albumId=${albumId}`)).status).toBe(
      404,
    );
  });

  test("404 while the switch is off, for an invitation, and for other people's photos", async () => {
    const { alice, bob, carol, albumId, alicePhoto, bobPhoto } = await setup({
      membersCanAdd: false,
    });
    expect((await add(bob, albumId, [bobPhoto.photoId])).status).toBe(404);

    await api(alice, "PATCH", `/albums/${albumId}`, { membersCanAdd: true });
    const carolPhoto = await readyPhoto(carol);
    expect((await add(carol, albumId, [carolPhoto.photoId])).status).toBe(404);
    // Someone else's photo can't be added, not even one already in the album.
    expect((await add(bob, albumId, [alicePhoto.photoId])).status).toBe(404);
    expect((await repos.albums.get(alice, albumId))?.photoCount).toBe(1);
  });

  test("the transaction refuses an add once the share is gone", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await repos.shares.delete(albumId, bob);
    const results = await repos.albums.addMemberPhotos(
      bob,
      alice,
      albumId,
      [bobPhoto.photoId],
      nextIso(),
    );
    expect(results.get(bobPhoto.photoId)).toBe("not-allowed");
    expect(await repos.albums.getMembership(albumId, bobPhoto.photoId)).toBeNull();
  });

  test("turning the switch off keeps the photos already added", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    await api(alice, "PATCH", `/albums/${albumId}`, { membersCanAdd: false });
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).toContain(bobPhoto.photoId);
  });
});

describe("DELETE /albums/{albumId}/photos/{photoId}", () => {
  test("a member removes their own photo, not the owner's", async () => {
    const { alice, bob, albumId, alicePhoto, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    expect(
      (await api(bob, "DELETE", `/albums/${albumId}/photos/${alicePhoto.photoId}`)).status,
    ).toBe(404);
    expect((await api(bob, "DELETE", `/albums/${albumId}/photos/${bobPhoto.photoId}`)).status).toBe(
      204,
    );
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).toEqual([alicePhoto.photoId]);
    expect((await repos.albums.get(alice, albumId))?.photoCount).toBe(1);
  });

  test("the owner removes a member's photo; it stays in the member's gallery", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    expect(
      (await api(alice, "DELETE", `/albums/${albumId}/photos/${bobPhoto.photoId}`)).status,
    ).toBe(204);
    const kept = await repos.photos.get(bob, bobPhoto.photoId);
    expect(kept).not.toBeNull();
    expect(kept?.albumIds).toBeUndefined();
  });
});

describe("leaving and removal", () => {
  test("a member who leaves takes their photos out of the album", async () => {
    const { alice, bob, albumId, alicePhoto, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    expect((await api(bob, "DELETE", `/shared-albums/${albumId}`)).status).toBe(204);
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).toEqual([alicePhoto.photoId]);
    expect((await repos.albums.get(alice, albumId))?.photoCount).toBe(1);
    expect((await repos.photos.get(bob, bobPhoto.photoId))?.albumIds).toBeUndefined();
  });

  test("the owner removing a member takes the member's photos out", async () => {
    const { alice, bob, albumId, alicePhoto, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    expect((await api(alice, "DELETE", `/albums/${albumId}/shares/${bob}`)).status).toBe(204);
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).toEqual([alicePhoto.photoId]);
  });

  test("photos of someone without an accepted share are hidden even before the clean-up", async () => {
    const { alice, bob, albumId, alicePhoto, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    await repos.shares.delete(albumId, bob); // no clean-up
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).toEqual([alicePhoto.photoId]);
    expect((await api(alice, "GET", `/photos/${bobPhoto.photoId}?albumId=${albumId}`)).status).toBe(
      404,
    );
  });

  test("deleting the album unlinks members' photos and keeps them", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    expect((await api(alice, "DELETE", `/albums/${albumId}`)).status).toBe(204);
    const kept = await repos.photos.get(bob, bobPhoto.photoId);
    expect(kept).not.toBeNull();
    expect(kept?.albumIds).toBeUndefined();
  });
});

describe("trash", () => {
  test("a member's trashed photo leaves the album and comes back on restore while allowed", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    expect((await api(bob, "DELETE", `/photos/${bobPhoto.photoId}`)).status).toBe(204);
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).not.toContain(
      bobPhoto.photoId,
    );
    expect((await repos.albums.get(alice, albumId))?.photoCount).toBe(1);

    expect((await api(bob, "POST", `/trash/${bobPhoto.photoId}/restore`)).status).toBe(200);
    expect((await listPhotos(alice, albumId)).map((p) => p.photoId)).toContain(bobPhoto.photoId);
    expect((await repos.albums.get(alice, albumId))?.photoCount).toBe(2);
  });

  test("a restore doesn't put it back once the owner turned the switch off", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    await api(bob, "DELETE", `/photos/${bobPhoto.photoId}`);
    await api(alice, "PATCH", `/albums/${albumId}`, { membersCanAdd: false });
    expect((await api(bob, "POST", `/trash/${bobPhoto.photoId}/restore`)).status).toBe(200);
    expect(await repos.albums.getMembership(albumId, bobPhoto.photoId)).toBeNull();
    expect((await repos.albums.get(alice, albumId))?.photoCount).toBe(1);
  });
});

describe("viewer, download, cover and save for the owner", () => {
  test("the owner opens and downloads a member's photo through the album", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    const one = await api(alice, "GET", `/photos/${bobPhoto.photoId}?albumId=${albumId}`);
    expect(one.status).toBe(200);
    const photo = photoSchema.parse(one.body);
    expect(photo).toMatchObject({ ownerId: bob, ownerUsername: `bob_${bob.slice(0, 6)}` });
    verifySignedUrl(photo.previewUrl!, `/users/${bob}/previews/${bobPhoto.photoId}.jpg`);
    expect(
      (await api(alice, "GET", `/photos/${bobPhoto.photoId}/download-url?albumId=${albumId}`))
        .status,
    ).toBe(200);
    // Not without the album.
    expect((await api(alice, "GET", `/photos/${bobPhoto.photoId}`)).status).toBe(404);
  });

  test("a member's photo as cover: signed for the owner, cleared when the member leaves", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    const res = await api(alice, "PATCH", `/albums/${albumId}`, { coverPhotoId: bobPhoto.photoId });
    expect(res.status).toBe(200);
    verifySignedUrl(
      albumSchema.parse(res.body).coverThumbUrl!,
      `/users/${bob}/thumbs/${bobPhoto.photoId}.jpg`,
    );
    const forBob = sharedAlbumPageSchema.parse((await api(bob, "GET", "/shared-albums")).body);
    expect(forBob.items.find((a) => a.albumId === albumId)?.coverPhotoId).toBe(bobPhoto.photoId);

    await api(bob, "DELETE", `/shared-albums/${albumId}`);
    const own = albumListSchema.parse((await api(alice, "GET", "/albums")).body).items;
    expect(own.find((a) => a.albumId === albumId)).toMatchObject({
      coverPhotoId: null,
      coverThumbUrl: null,
    });
  });

  test("the owner saves a member's photo to her gallery; her own are already saved", async () => {
    const { alice, bob, albumId, alicePhoto, bobPhoto } = await setup();
    await add(bob, albumId, [bobPhoto.photoId]);
    const res = await api(alice, "POST", `/albums/${albumId}/save`, {
      photoIds: [bobPhoto.photoId, alicePhoto.photoId],
    });
    expect(res.status).toBe(200);
    const { items } = saveSharedPhotosResponseSchema.parse(res.body);
    expect(items.map((i) => i.result)).toEqual(["saved", "already-saved"]);
    expect(items[1]?.savedPhotoId).toBe(alicePhoto.photoId);
    expect(await repos.photos.get(alice, items[0]!.savedPhotoId!)).toMatchObject({
      status: "pending",
    });
  });

  test("a member saves another member's photo through the shared route", async () => {
    const { alice, bob, albumId, bobPhoto } = await setup();
    const dave = newUserId();
    await repos.shares.create({
      albumId,
      ownerId: alice,
      userId: dave,
      status: "accepted",
      sharedAt: nextIso(),
    });
    await add(bob, albumId, [bobPhoto.photoId]);
    const res = await api(dave, "POST", `/shared-albums/${albumId}/save`, {
      photoIds: [bobPhoto.photoId],
    });
    expect(saveSharedPhotosResponseSchema.parse(res.body).items[0]?.result).toBe("saved");
  });
});
