/** Sharing routes (5.12) on DynamoDB Local with a fake Cognito directory. */
import {
  albumShareListSchema,
  albumShareSchema,
  apiErrorSchema,
  newId,
  shareInvitationPageSchema,
  sharedAlbumPageSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Db, Repositories } from "../src/repo";
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
let profiles: TestApi["profiles"];
beforeAll(async () => {
  ({ db, repos, api, profiles } = await createTestApi());
});

function errorCode(body: unknown) {
  return apiErrorSchema.parse(body).error.code;
}

/** A registered user with a unique email. */
function register(name = "User", userId: string = newUserId()) {
  const email = `${name.toLowerCase()}-${userId.slice(0, 8)}@example.com`;
  profiles.set(userId, { email, name });
  return { userId, email };
}

async function album(ownerId: string, name = "Trip") {
  return repos.albums.create({ ownerId, albumId: newId(), name, createdAt: nextIso() });
}

/** The owner shares by email and the recipient accepts (FR-SHR-1, FR-SHR-6). */
async function shareAccepted(
  ownerId: string,
  albumId: string,
  recipient: { userId: string; email: string },
) {
  await api(ownerId, "POST", `/albums/${albumId}/shares`, { email: recipient.email });
  expect((await api(recipient.userId, "POST", `/shared-albums/${albumId}/accept`)).status).toBe(
    204,
  );
}

describe("POST /albums/{albumId}/shares (FR-SHR-1)", () => {
  test("shares with the registered user who has the email → 201, as an invitation", async () => {
    const owner = register("Owner");
    const friend = register("Friend");
    const a = await album(owner.userId);

    const res = await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, {
      email: friend.email,
    });

    expect(res.status).toBe(201);
    const share = albumShareSchema.parse(res.body);
    expect(share).toMatchObject({ userId: friend.userId, email: friend.email, status: "pending" });
    expect(await repos.shares.get(a.albumId, friend.userId)).toMatchObject({
      ownerId: owner.userId,
      status: "pending",
      sharedAt: share.sharedAt,
    });
  });

  test("email is matched after trimming and lowercasing", async () => {
    const owner = register();
    const friend = register("Friend");
    const a = await album(owner.userId);

    const res = await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, {
      email: `  ${friend.email.toUpperCase()} `,
    });
    expect(res.status).toBe(201);
    expect(albumShareSchema.parse(res.body).userId).toBe(friend.userId);
  });

  test("sharing again → 200 with the original share", async () => {
    const owner = register();
    const friend = register();
    const a = await album(owner.userId);
    const path = `/albums/${a.albumId}/shares`;

    const first = await api(owner.userId, "POST", path, { email: friend.email });
    const again = await api(owner.userId, "POST", path, { email: friend.email });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await repos.shares.listForAlbum(a.albumId)).toHaveLength(1);
  });

  test("unknown email → 404 SHARE_TARGET_NOT_FOUND", async () => {
    const owner = register();
    const a = await album(owner.userId);

    const res = await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, {
      email: "nobody@example.com",
    });
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("SHARE_TARGET_NOT_FOUND");
  });

  test("own email → 400 VALIDATION_ERROR", async () => {
    const owner = register();
    const a = await album(owner.userId);

    const res = await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, {
      email: owner.email,
    });
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_ERROR");
  });

  test("someone else's album → 404 NOT_FOUND before any email lookup (NFR-SEC-2)", async () => {
    const owner = register();
    const intruder = register();
    const a = await album(owner.userId);

    // A registered and an unregistered email give the same answer, so the route reveals nothing.
    for (const email of [owner.email, "nobody@example.com"]) {
      const res = await api(intruder.userId, "POST", `/albums/${a.albumId}/shares`, { email });
      expect(res.status).toBe(404);
      expect(errorCode(res.body)).toBe("NOT_FOUND");
    }
    expect(await repos.shares.listForAlbum(a.albumId)).toEqual([]);
  });

  test("recipients can't re-share (FR-SHR-4)", async () => {
    const owner = register();
    const friend = register();
    const third = register();
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: friend.email });

    const res = await api(friend.userId, "POST", `/albums/${a.albumId}/shares`, {
      email: third.email,
    });
    expect(res.status).toBe(404);
    expect(await repos.shares.get(a.albumId, third.userId)).toBeNull();
  });

  test("invalid email → 400, invalid album ID → 400, anonymous → 401", async () => {
    const owner = register();
    const a = await album(owner.userId);
    const path = `/albums/${a.albumId}/shares`;
    expect((await api(owner.userId, "POST", path, { email: "not-an-email" })).status).toBe(400);
    expect((await api(owner.userId, "POST", path, {})).status).toBe(400);
    expect(
      (await api(owner.userId, "POST", "/albums/nope/shares", { email: "a@b.co" })).status,
    ).toBe(400);
    expect((await api(null, "POST", path, { email: "a@b.co" })).status).toBe(401);
  });
});

describe("GET /albums/{albumId}/shares", () => {
  test("owner sees every share, oldest first", async () => {
    const owner = register();
    const [f1, f2] = [register(), register()];
    const a = await album(owner.userId);
    for (const friend of [f1, f2]) {
      await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: friend.email });
    }

    const res = await api(owner.userId, "GET", `/albums/${a.albumId}/shares`);
    expect(res.status).toBe(200);
    const { items } = albumShareListSchema.parse(res.body);
    expect(items.map((s) => [s.userId, s.email]).sort()).toEqual(
      [
        [f1.userId, f1.email],
        [f2.userId, f2.email],
      ].sort(),
    );
    // Two shares made back to back can carry the same millisecond, so check the order itself.
    const dates = items.map((s) => s.sharedAt);
    expect(dates).toEqual([...dates].sort());
  });

  test("empty list for an unshared album", async () => {
    const owner = register();
    const a = await album(owner.userId);
    const res = await api(owner.userId, "GET", `/albums/${a.albumId}/shares`);
    expect(res.body).toEqual({ items: [] });
  });

  test("recipients and other users → 404", async () => {
    const owner = register();
    const friend = register();
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: friend.email });

    for (const caller of [friend.userId, newUserId()]) {
      expect((await api(caller, "GET", `/albums/${a.albumId}/shares`)).status).toBe(404);
    }
  });
});

describe("DELETE /albums/{albumId}/shares/{userId} (FR-SHR-2)", () => {
  test("owner revokes → 204; the album leaves the recipient's list", async () => {
    const owner = register();
    const friend = register();
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: friend.email });

    const res = await api(owner.userId, "DELETE", `/albums/${a.albumId}/shares/${friend.userId}`);
    expect(res.status).toBe(204);
    expect(await repos.shares.get(a.albumId, friend.userId)).toBeNull();
    expect((await api(friend.userId, "GET", "/shared-albums")).body).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("not shared with that user → 404; revoking twice → 404", async () => {
    const owner = register();
    const friend = register();
    const a = await album(owner.userId);
    const path = `/albums/${a.albumId}/shares/${friend.userId}`;
    expect((await api(owner.userId, "DELETE", path)).status).toBe(404);

    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: friend.email });
    expect((await api(owner.userId, "DELETE", path)).status).toBe(204);
    expect((await api(owner.userId, "DELETE", path)).status).toBe(404);
  });

  test("recipients can't revoke, not even their own share (FR-SHR-4)", async () => {
    const owner = register();
    const friend = register();
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: friend.email });

    const path = `/albums/${a.albumId}/shares/${friend.userId}`;
    expect((await api(friend.userId, "DELETE", path)).status).toBe(404);
    expect(await repos.shares.get(a.albumId, friend.userId)).not.toBeNull();
  });

  // Cognito subs aren't always RFC 4122 UUIDs (variant `e` here, a real dev user); z.uuid() made
  // this route answer 400 for them.
  test("revokes a share with a user whose sub isn't an RFC 4122 UUID", async () => {
    const owner = register();
    const friend = register("Friend", `${newUserId().slice(0, 19)}e65a-20ae6c5231fc`);
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: friend.email });
    const list = await api(owner.userId, "GET", `/albums/${a.albumId}/shares`);
    expect(albumShareListSchema.parse(list.body).items[0]!.userId).toBe(friend.userId);

    const path = `/albums/${a.albumId}/shares/${friend.userId}`;
    expect((await api(owner.userId, "DELETE", path)).status).toBe(204);
  });

  test("invalid user ID → 400", async () => {
    const owner = register();
    const a = await album(owner.userId);
    expect((await api(owner.userId, "DELETE", `/albums/${a.albumId}/shares/x`)).status).toBe(400);
  });
});

describe("GET /shared-albums (FR-SHR-3)", () => {
  test("albums shared with me, with owner and share date, paginated", async () => {
    const [alice, bob, me] = [register("Alice"), register("Bob"), register("Me")];
    const a = await album(alice.userId, "Alice's");
    const b = await album(bob.userId, "Bob's");
    await album(alice.userId, "Not shared");
    const photo = await createPending(repos, newPhoto(alice.userId));
    await repos.albums.addPhotos(alice.userId, a.albumId, [photo.photoId], nextIso());
    await repos.albums.update(alice.userId, a.albumId, { coverPhotoId: photo.photoId });
    for (const [owner, x] of [
      [alice, a],
      [bob, b],
    ] as const) {
      await shareAccepted(owner.userId, x.albumId, me);
    }

    const first = sharedAlbumPageSchema.parse(
      (await api(me.userId, "GET", "/shared-albums?limit=1")).body,
    );
    const second = sharedAlbumPageSchema.parse(
      (await api(me.userId, "GET", `/shared-albums?limit=1&cursor=${first.nextCursor}`)).body,
    );
    const items = [...first.items, ...second.items];
    expect(second.nextCursor).toBeNull();
    expect(items.map((x) => x.name).sort()).toEqual(["Alice's", "Bob's"]);

    const shared = items.find((x) => x.albumId === a.albumId)!;
    expect(shared).toMatchObject({
      ownerId: alice.userId,
      photoCount: 1,
      coverPhotoId: photo.photoId,
      // The cover is still processing: recipients only ever see ready photos.
      coverThumbUrl: null,
    });
    expect(shared.sharedAt).toBe((await repos.shares.get(a.albumId, me.userId))!.sharedAt);
  });

  test("a ready cover gets a signed URL for the owner's thumbnail (7.4)", async () => {
    const [alice, bob, me] = [register("Alice"), register("Bob"), register("Me")];
    const a = await album(alice.userId, "Alice's");
    const b = await album(bob.userId, "Bob's, no cover");
    const photo = await createPending(repos, newPhoto(alice.userId));
    await markReady(db, alice.userId, photo.photoId, 1000, "2025-06-01T12:00:00.000Z");
    await repos.albums.addPhotos(alice.userId, a.albumId, [photo.photoId], nextIso());
    await repos.albums.update(alice.userId, a.albumId, { coverPhotoId: photo.photoId });
    for (const [owner, x] of [
      [alice, a],
      [bob, b],
    ] as const) {
      await shareAccepted(owner.userId, x.albumId, me);
    }

    const { items } = sharedAlbumPageSchema.parse(
      (await api(me.userId, "GET", "/shared-albums")).body,
    );
    const cover = items.find((x) => x.albumId === a.albumId)!.coverThumbUrl!;
    verifySignedUrl(cover, `/users/${alice.userId}/thumbs/${photo.photoId}.jpg`);
    expect(items.find((x) => x.albumId === b.albumId)!.coverThumbUrl).toBeNull();
  });

  test("shared albums stay out of my own album list, and I can't modify them (FR-SHR-4)", async () => {
    const owner = register();
    const me = register();
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: me.email });

    expect((await api(me.userId, "GET", "/albums")).body).toEqual({ items: [] });
    expect((await api(me.userId, "PATCH", `/albums/${a.albumId}`, { name: "Mine" })).status).toBe(
      404,
    );
    expect((await api(me.userId, "DELETE", `/albums/${a.albumId}`)).status).toBe(404);
    expect(
      (await api(me.userId, "POST", `/albums/${a.albumId}/photos`, { photoIds: [newId()] })).status,
    ).toBe(404);
    expect((await repos.albums.get(owner.userId, a.albumId))?.name).toBe("Trip");
  });

  test("a deleted album disappears from the list", async () => {
    const owner = register();
    const me = register();
    const a = await album(owner.userId);
    await shareAccepted(owner.userId, a.albumId, me);
    expect((await api(owner.userId, "DELETE", `/albums/${a.albumId}`)).status).toBe(204);

    expect((await api(me.userId, "GET", "/shared-albums")).body).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("invalid limit → 400, anonymous → 401", async () => {
    expect((await api(newUserId(), "GET", "/shared-albums?limit=0")).status).toBe(400);
    expect((await api(null, "GET", "/shared-albums")).status).toBe(401);
  });
});

describe("invitations: accept, decline, leave (FR-SHR-6/7)", () => {
  test("a new share is an invitation: listed apart, no access until accepted", async () => {
    const [owner, me] = [register("Owner"), register("Me")];
    const a = await album(owner.userId, "Summer");
    const photo = await createPending(repos, newPhoto(owner.userId));
    await markReady(db, owner.userId, photo.photoId, 1000, "2025-06-01T12:00:00.000Z");
    await repos.albums.addPhotos(owner.userId, a.albumId, [photo.photoId], nextIso());
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: me.email });

    const invited = shareInvitationPageSchema.parse(
      (await api(me.userId, "GET", "/share-invitations")).body,
    );
    expect(invited).toEqual({
      items: [
        {
          albumId: a.albumId,
          name: "Summer",
          photoCount: 1,
          ownerId: owner.userId,
          ownerUsername: null,
          sharedAt: (await repos.shares.get(a.albumId, me.userId))!.sharedAt,
        },
      ],
      nextCursor: null,
    });
    expect((await api(me.userId, "GET", "/shared-albums")).body).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await api(me.userId, "GET", `/albums/${a.albumId}/photos`)).status).toBe(404);
    expect(
      (await api(me.userId, "GET", `/photos/${photo.photoId}?albumId=${a.albumId}`)).status,
    ).toBe(404);
    expect(
      (await api(me.userId, "GET", `/photos/${photo.photoId}/download-url?albumId=${a.albumId}`))
        .status,
    ).toBe(404);
  });

  test("accepting → 204: the album moves to Shared with me and opens; accepting again → 204", async () => {
    const [owner, me] = [register(), register()];
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: me.email });

    const path = `/shared-albums/${a.albumId}/accept`;
    expect((await api(me.userId, "POST", path)).status).toBe(204);
    expect((await api(me.userId, "POST", path)).status).toBe(204);

    expect((await api(me.userId, "GET", "/share-invitations")).body).toEqual({
      items: [],
      nextCursor: null,
    });
    const shared = sharedAlbumPageSchema.parse(
      (await api(me.userId, "GET", "/shared-albums")).body,
    );
    expect(shared.items.map((x) => x.albumId)).toEqual([a.albumId]);
    expect((await api(me.userId, "GET", `/albums/${a.albumId}/photos`)).status).toBe(200);
    expect(await repos.shares.get(a.albumId, me.userId)).toMatchObject({
      status: "accepted",
      acceptedAt: expect.any(String),
    });

    // The owner sees it accepted.
    const list = albumShareListSchema.parse(
      (await api(owner.userId, "GET", `/albums/${a.albumId}/shares`)).body,
    );
    expect(list.items.map((x) => x.status)).toEqual(["accepted"]);
  });

  test("shares made before invitations (no status) count as accepted", async () => {
    const [owner, me] = [register(), register()];
    const a = await album(owner.userId);
    await repos.shares.create({
      albumId: a.albumId,
      ownerId: owner.userId,
      userId: me.userId,
      sharedAt: nextIso(),
    });
    const shared = sharedAlbumPageSchema.parse(
      (await api(me.userId, "GET", "/shared-albums")).body,
    );
    expect(shared.items.map((x) => x.albumId)).toEqual([a.albumId]);
    expect((await api(me.userId, "GET", `/albums/${a.albumId}/photos`)).status).toBe(200);
    expect((await api(me.userId, "POST", `/shared-albums/${a.albumId}/accept`)).status).toBe(204);
    const list = albumShareListSchema.parse(
      (await api(owner.userId, "GET", `/albums/${a.albumId}/shares`)).body,
    );
    expect(list.items[0]?.status).toBe("accepted");
  });

  test("declining → 204: the invitation and the owner's share are gone", async () => {
    const [owner, me] = [register(), register()];
    const a = await album(owner.userId);
    await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, { email: me.email });

    expect((await api(me.userId, "DELETE", `/shared-albums/${a.albumId}`)).status).toBe(204);
    expect((await api(me.userId, "GET", "/share-invitations")).body).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await api(owner.userId, "GET", `/albums/${a.albumId}/shares`)).body).toEqual({
      items: [],
    });
    expect((await api(me.userId, "POST", `/shared-albums/${a.albumId}/accept`)).status).toBe(404);
  });

  test("leaving an accepted album → 204: access ends at once; again → 404", async () => {
    const [owner, me] = [register(), register()];
    const a = await album(owner.userId);
    await shareAccepted(owner.userId, a.albumId, me);

    const path = `/shared-albums/${a.albumId}`;
    expect((await api(me.userId, "DELETE", path)).status).toBe(204);
    expect((await api(me.userId, "GET", `/albums/${a.albumId}/photos`)).status).toBe(404);
    expect((await api(me.userId, "GET", "/shared-albums")).body).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await api(me.userId, "DELETE", path)).status).toBe(404);
    // The album itself is untouched.
    expect(await repos.albums.get(owner.userId, a.albumId)).not.toBeNull();
  });

  test("after a decline the owner can share again: a new invitation (201)", async () => {
    const [owner, me] = [register(), register()];
    const a = await album(owner.userId);
    const path = `/albums/${a.albumId}/shares`;
    await api(owner.userId, "POST", path, { email: me.email });
    await api(me.userId, "DELETE", `/shared-albums/${a.albumId}`);

    const again = await api(owner.userId, "POST", path, { email: me.email });
    expect(again.status).toBe(201);
    expect(albumShareSchema.parse(again.body).status).toBe("pending");
    const invited = shareInvitationPageSchema.parse(
      (await api(me.userId, "GET", "/share-invitations")).body,
    );
    expect(invited.items.map((x) => x.albumId)).toEqual([a.albumId]);
  });

  test("sharing an accepted album again keeps it accepted (200)", async () => {
    const [owner, me] = [register(), register()];
    const a = await album(owner.userId);
    await shareAccepted(owner.userId, a.albumId, me);
    const res = await api(owner.userId, "POST", `/albums/${a.albumId}/shares`, {
      email: me.email,
    });
    expect(res.status).toBe(200);
    expect(albumShareSchema.parse(res.body).status).toBe("accepted");
  });

  test("invitations are paginated; an album deleted meanwhile is skipped", async () => {
    const [alice, bob, me] = [register(), register(), register()];
    const a = await album(alice.userId, "A");
    const b = await album(bob.userId, "B");
    const gone = await album(bob.userId, "Gone");
    for (const [owner, x] of [
      [alice, a],
      [bob, b],
      [bob, gone],
    ] as const) {
      await api(owner.userId, "POST", `/albums/${x.albumId}/shares`, { email: me.email });
    }
    expect((await api(bob.userId, "DELETE", `/albums/${gone.albumId}`)).status).toBe(204);

    const first = shareInvitationPageSchema.parse(
      (await api(me.userId, "GET", "/share-invitations?limit=1")).body,
    );
    const second = shareInvitationPageSchema.parse(
      (await api(me.userId, "GET", `/share-invitations?limit=1&cursor=${first.nextCursor}`)).body,
    );
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((x) => x.name).sort()).toEqual(["A", "B"]);
  });

  test("invalid album ID → 400, anonymous → 401", async () => {
    expect((await api(newUserId(), "POST", "/shared-albums/nope/accept")).status).toBe(400);
    expect((await api(newUserId(), "DELETE", "/shared-albums/nope")).status).toBe(400);
    expect((await api(newUserId(), "GET", "/share-invitations?limit=0")).status).toBe(400);
    expect((await api(null, "GET", "/share-invitations")).status).toBe(401);
    expect((await api(null, "POST", `/shared-albums/${newId()}/accept`)).status).toBe(401);
    expect((await api(null, "DELETE", `/shared-albums/${newId()}`)).status).toBe(401);
  });
});
