/**
 * Shared albums members can add to (FR-SHR-9): the owner switches `membersCanAdd` on, members who
 * accepted the share add their own photos (which stay theirs), everyone in the album sees them,
 * and they leave the album when the member does.
 */
import {
  albumSchema,
  downloadUrlResponseSchema,
  newId,
  photoPageSchema,
  photoSchema,
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
 * `owner`'s album with one of their photos, shared (accepted) with `member` and `other`, and as an
 * invitation with `invited`. `membersCanAdd` on unless `canAdd: false`.
 */
async function setup({ canAdd = true } = {}) {
  const owner = newUserId();
  const member = newUserId();
  const other = newUserId();
  const invited = newUserId();
  const album = await repos.albums.create({
    ownerId: owner,
    albumId: newId(),
    name: "Trip",
    createdAt: nextIso(),
  });
  const ownerPhoto = await readyPhoto(owner);
  await repos.albums.addPhotos(owner, album.albumId, [ownerPhoto.photoId], nextIso());
  if (canAdd) await repos.albums.update(owner, album.albumId, { membersCanAdd: true });
  for (const [userId, status] of [
    [member, "accepted"],
    [other, "accepted"],
    [invited, "pending"],
  ] as const) {
    await repos.shares.create({
      albumId: album.albumId,
      ownerId: owner,
      userId,
      status,
      sharedAt: nextIso(),
    });
  }
  const memberPhoto = await readyPhoto(member);
  const add = (as: string, photoIds: string[]) =>
    api(as, "POST", `/albums/${album.albumId}/photos`, { photoIds });
  const listIds = async (as: string) => {
    const res = await api(as, "GET", `/albums/${album.albumId}/photos`);
    expect(res.status).toBe(200);
    return photoPageSchema.parse(res.body).items.map((photo) => photo.photoId);
  };
  return { owner, member, other, invited, album, ownerPhoto, memberPhoto, add, listIds };
}

describe("membersCanAdd switch (PATCH /albums/{id})", () => {
  test("the owner turns it on and off; albums and shared albums report it", async () => {
    const { owner, member, album } = await setup({ canAdd: false });

    const on = await api(owner, "PATCH", `/albums/${album.albumId}`, { membersCanAdd: true });
    expect(on.status).toBe(200);
    expect(albumSchema.parse(on.body).membersCanAdd).toBe(true);

    const shared = sharedAlbumPageSchema.parse((await api(member, "GET", "/shared-albums")).body);
    expect(shared.items).toMatchObject([{ albumId: album.albumId, membersCanAdd: true }]);

    const off = await api(owner, "PATCH", `/albums/${album.albumId}`, { membersCanAdd: false });
    expect(albumSchema.parse(off.body).membersCanAdd).toBe(false);
  });

  test("a member can't switch it (404, like any change to someone else's album)", async () => {
    const { member, album } = await setup({ canAdd: false });
    const res = await api(member, "PATCH", `/albums/${album.albumId}`, { membersCanAdd: true });
    expect(res.status).toBe(404);
  });
});

describe("POST /albums/{id}/photos by a member", () => {
  test("adds their own photo; it stays theirs and counts in the album", async () => {
    const { owner, member, album, memberPhoto, add } = await setup();

    expect((await add(member, [memberPhoto.photoId])).status).toBe(204);

    expect((await repos.albums.get(owner, album.albumId))!.photoCount).toBe(2);
    const stored = (await repos.photos.get(member, memberPhoto.photoId))!;
    expect([...stored.albumIds!]).toEqual([album.albumId]);
    // Idempotent, like the owner's adds.
    expect((await add(member, [memberPhoto.photoId])).status).toBe(204);
    expect((await repos.albums.get(owner, album.albumId))!.photoCount).toBe(2);
  });

  test("403 while the owner doesn't let members add", async () => {
    const { member, memberPhoto, add, listIds, owner, ownerPhoto } = await setup({
      canAdd: false,
    });
    const res = await add(member, [memberPhoto.photoId]);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await listIds(owner)).toEqual([ownerPhoto.photoId]);
  });

  test("an invitation not accepted yet gives no right to add (404)", async () => {
    const { invited, add } = await setup();
    const photo = await readyPhoto(invited);
    expect((await add(invited, [photo.photoId])).status).toBe(404);
  });

  test("someone else's photo → 404, nothing added", async () => {
    const { member, other, add, owner, ownerPhoto, listIds } = await setup();
    const othersPhoto = await readyPhoto(other);
    expect((await add(member, [othersPhoto.photoId])).status).toBe(404);
    expect(await listIds(owner)).toEqual([ownerPhoto.photoId]);
  });
});

describe("seeing members' photos", () => {
  test("everyone sees them; own photos with stable paths, others' signed", async () => {
    const { owner, member, other, album, ownerPhoto, memberPhoto, add } = await setup();
    await add(member, [memberPhoto.photoId]);
    const page = async (as: string) =>
      new Map(
        photoPageSchema
          .parse((await api(as, "GET", `/albums/${album.albumId}/photos`)).body)
          .items.map((photo) => [photo.photoId, photo]),
      );

    const ownersView = await page(owner);
    expect(ownersView.get(ownerPhoto.photoId)!.thumbUrl).toBe(
      `/users/${owner}/thumbs/${ownerPhoto.photoId}.jpg`,
    );
    expect(ownersView.get(memberPhoto.photoId)!.ownerId).toBe(member);
    verifySignedUrl(
      ownersView.get(memberPhoto.photoId)!.thumbUrl!,
      `/users/${member}/thumbs/${memberPhoto.photoId}.jpg`,
    );

    const membersView = await page(member);
    expect(membersView.get(memberPhoto.photoId)!.thumbUrl).toBe(
      `/users/${member}/thumbs/${memberPhoto.photoId}.jpg`,
    );
    verifySignedUrl(
      membersView.get(ownerPhoto.photoId)!.thumbUrl!,
      `/users/${owner}/thumbs/${ownerPhoto.photoId}.jpg`,
    );

    const othersView = await page(other);
    expect([...othersView.keys()].sort()).toEqual([ownerPhoto.photoId, memberPhoto.photoId].sort());
  });

  test("a member's upload still processing is shown to them only", async () => {
    const { owner, member, other, add, listIds } = await setup();
    const pending = await createPending(repos, newPhoto(member));
    expect((await add(member, [pending.photoId])).status).toBe(204);

    expect(await listIds(member)).toContain(pending.photoId);
    expect(await listIds(owner)).not.toContain(pending.photoId);
    expect(await listIds(other)).not.toContain(pending.photoId);
  });

  test("the owner and other members open and download a member's photo via ?albumId=", async () => {
    const { owner, member, other, album, memberPhoto, add } = await setup();
    await add(member, [memberPhoto.photoId]);

    for (const as of [owner, other]) {
      const res = await api(as, "GET", `/photos/${memberPhoto.photoId}?albumId=${album.albumId}`);
      expect(res.status).toBe(200);
      const photo = photoSchema.parse(res.body);
      verifySignedUrl(photo.previewUrl!, `/users/${member}/previews/${memberPhoto.photoId}.jpg`);
      expect(photo.place).toBeNull();

      const download = await api(
        as,
        "GET",
        `/photos/${memberPhoto.photoId}/download-url?albumId=${album.albumId}`,
      );
      expect(download.status).toBe(200);
      downloadUrlResponseSchema.parse(download.body);
    }
    // Not without the album, and not through an album it isn't in.
    expect((await api(owner, "GET", `/photos/${memberPhoto.photoId}`)).status).toBe(404);
  });

  test("the cover stays one of the owner's own photos", async () => {
    const { owner, member, album, memberPhoto, add } = await setup();
    await add(member, [memberPhoto.photoId]);
    const res = await api(owner, "PATCH", `/albums/${album.albumId}`, {
      coverPhotoId: memberPhoto.photoId,
    });
    expect(res.status).toBe(400);
  });
});

describe("removing members' photos", () => {
  test("a member removes their own photo, not the owner's or another member's", async () => {
    const { owner, member, other, album, ownerPhoto, memberPhoto, add, listIds } = await setup();
    const othersPhoto = await readyPhoto(other);
    await add(member, [memberPhoto.photoId]);
    await add(other, [othersPhoto.photoId]);
    const remove = (as: string, photoId: string) =>
      api(as, "DELETE", `/albums/${album.albumId}/photos/${photoId}`);

    expect((await remove(member, ownerPhoto.photoId)).status).toBe(404);
    expect((await remove(member, othersPhoto.photoId)).status).toBe(404);
    expect((await remove(member, memberPhoto.photoId)).status).toBe(204);

    expect((await listIds(owner)).sort()).toEqual([ownerPhoto.photoId, othersPhoto.photoId].sort());
    expect((await repos.photos.get(member, memberPhoto.photoId))!.albumIds).toBeUndefined();
  });

  test("the owner removes a member's photo; it stays in the member's gallery", async () => {
    const { owner, member, album, memberPhoto, add } = await setup();
    await add(member, [memberPhoto.photoId]);

    const res = await api(
      owner,
      "DELETE",
      `/albums/${album.albumId}/photos/${memberPhoto.photoId}`,
    );
    expect(res.status).toBe(204);
    expect((await repos.albums.get(owner, album.albumId))!.photoCount).toBe(1);
    const gallery = photoPageSchema.parse((await api(member, "GET", "/photos")).body);
    expect(gallery.items.map((photo) => photo.photoId)).toEqual([memberPhoto.photoId]);
  });

  test("leaving the album takes the member's photos out, the others stay", async () => {
    const { owner, member, album, ownerPhoto, memberPhoto, add, listIds } = await setup();
    await add(member, [memberPhoto.photoId]);

    expect((await api(member, "DELETE", `/shared-albums/${album.albumId}`)).status).toBe(204);

    expect(await listIds(owner)).toEqual([ownerPhoto.photoId]);
    expect((await repos.albums.get(owner, album.albumId))!.photoCount).toBe(1);
    expect(await repos.photos.get(member, memberPhoto.photoId)).not.toBeNull();
  });

  test("revoking the share takes the member's photos out", async () => {
    const { owner, member, album, ownerPhoto, memberPhoto, add, listIds } = await setup();
    await add(member, [memberPhoto.photoId]);

    const res = await api(owner, "DELETE", `/albums/${album.albumId}/shares/${member}`);
    expect(res.status).toBe(204);
    expect(await listIds(owner)).toEqual([ownerPhoto.photoId]);
  });

  test("the owner leaving their own album as if shared removes nothing (404)", async () => {
    const { owner, album, ownerPhoto, listIds } = await setup();
    expect((await api(owner, "DELETE", `/shared-albums/${album.albumId}`)).status).toBe(404);
    expect(await listIds(owner)).toEqual([ownerPhoto.photoId]);
  });

  test("deleting the album unlinks the members' photos", async () => {
    const { owner, member, album, memberPhoto, add } = await setup();
    await add(member, [memberPhoto.photoId]);

    expect((await api(owner, "DELETE", `/albums/${album.albumId}`)).status).toBe(204);
    expect((await repos.photos.get(member, memberPhoto.photoId))!.albumIds).toBeUndefined();
  });

  test("the trash takes a member's photo out, a restore puts it back (FR-DEL-3)", async () => {
    const { owner, member, album, ownerPhoto, memberPhoto, add, listIds } = await setup();
    await add(member, [memberPhoto.photoId]);

    expect((await api(member, "DELETE", `/photos/${memberPhoto.photoId}`)).status).toBe(204);
    expect(await listIds(owner)).toEqual([ownerPhoto.photoId]);

    expect((await api(member, "POST", `/trash/${memberPhoto.photoId}/restore`)).status).toBe(200);
    expect((await listIds(owner)).sort()).toEqual([ownerPhoto.photoId, memberPhoto.photoId].sort());
    expect((await repos.albums.get(owner, album.albumId))!.photoCount).toBe(2);
  });

  test("a restore skips a shared album the member has left meanwhile", async () => {
    const { owner, member, album, ownerPhoto, memberPhoto, add, listIds } = await setup();
    await add(member, [memberPhoto.photoId]);
    await api(member, "DELETE", `/photos/${memberPhoto.photoId}`);
    await api(member, "DELETE", `/shared-albums/${album.albumId}`);

    expect((await api(member, "POST", `/trash/${memberPhoto.photoId}/restore`)).status).toBe(200);
    expect(await listIds(owner)).toEqual([ownerPhoto.photoId]);
  });
});
