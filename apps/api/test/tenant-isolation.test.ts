/**
 * Tenant-isolation suite (task 5.14, NFR-SEC-1/2): every route, called with IDs of resources the
 * caller may not touch, answers exactly like it does for IDs that don't exist (same status, same
 * body), and changes nothing. Recipients of a share count as outsiders for everything except
 * reading that album (FR-SHR-4), and only once they accepted it (FR-SHR-6).
 *
 * The route list is checked against the app's registered routes, so a new route without a case
 * here (or an explicit exemption) fails the suite.
 */
import {
  newId,
  photoPageSchema,
  shareInvitationPageSchema,
  sharedAlbumPageSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Repositories } from "../src/repo";
import {
  addPlaces,
  BERLIN,
  createPending,
  createTestApi,
  markReady,
  newPhoto,
  newUserId,
  nextIso,
} from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let t: TestApi;
let repos: Repositories;

/**
 * The world: Alice owns everything interesting. Album A (photos p1 + pending p3, cover p1) is
 * shared with Bob; album B (photo p2) is private; album C (photo p2 too) is an invitation Bob
 * hasn't accepted (FR-SHR-6), so it gives him nothing yet. Mallory is a stranger with her own
 * photo and album, so she can also try to mix her IDs with Alice's.
 */
const w = {
  alice: newUserId(),
  bob: newUserId(),
  mallory: newUserId(),
  p1: "",
  p2: "",
  p3: "",
  albumA: "",
  albumB: "",
  albumC: "",
  malloryPhoto: "",
  malloryAlbum: "",
  aliceCursor: "",
};

async function readyPhoto(userId: string) {
  const photo = await createPending(t.repos, newPhoto(userId));
  await markReady(t.db, userId, photo.photoId, 1000, "2025-06-01T12:00:00.000Z");
  return photo.photoId;
}

async function album(ownerId: string, name: string) {
  return (await repos.albums.create({ ownerId, albumId: newId(), name, createdAt: nextIso() }))
    .albumId;
}

beforeAll(async () => {
  t = await createTestApi();
  repos = t.repos;
  t.profiles.set(w.alice, { email: "alice@example.com", name: "Alice" });
  t.profiles.set(w.bob, { email: "bob@example.com", name: "Bob" });
  t.profiles.set(w.mallory, { email: "mallory@example.com", name: "Mallory" });
  await repos.usernames.set(w.alice, `alice_${Date.now().toString(36)}`, nextIso());

  w.p1 = await readyPhoto(w.alice);
  w.p2 = await readyPhoto(w.alice);
  w.p3 = (await createPending(repos, newPhoto(w.alice))).photoId;
  w.albumA = await album(w.alice, "Shared");
  w.albumB = await album(w.alice, "Private");
  await repos.albums.addPhotos(w.alice, w.albumA, [w.p1, w.p3], nextIso());
  await repos.albums.addPhotos(w.alice, w.albumB, [w.p2], nextIso());
  w.albumC = await album(w.alice, "Invited");
  await repos.albums.addPhotos(w.alice, w.albumC, [w.p2], nextIso());
  await repos.albums.update(w.alice, w.albumA, { coverPhotoId: w.p1 });
  await repos.shares.create({
    albumId: w.albumA,
    ownerId: w.alice,
    userId: w.bob,
    email: "bob@example.com",
    sharedAt: nextIso(),
  });
  await repos.shares.create({
    albumId: w.albumC,
    ownerId: w.alice,
    userId: w.bob,
    status: "pending",
    sharedAt: nextIso(),
  });

  // Alice took p1 and p2 in Berlin (13.2); places are hers only, also for Bob (13.2g).
  await addPlaces(t.db, w.alice, w.p1, BERLIN);
  await addPlaces(t.db, w.alice, w.p2, BERLIN);

  w.malloryPhoto = await readyPhoto(w.mallory);
  w.malloryAlbum = await album(w.mallory, "Mine");

  // A real cursor into Alice's gallery, to replay as someone else.
  const page = photoPageSchema.parse((await t.api(w.alice, "GET", "/photos?limit=1")).body);
  w.aliceCursor = page.nextCursor!;

  before = await snapshot();
});

/** Everything the cases could damage or leak, read straight from the repositories. */
async function snapshot() {
  return {
    photos: await repos.photos.list(w.alice, { sort: "taken-desc", limit: 100 }),
    albums: await repos.albums.list(w.alice),
    membersA: await repos.albums.listMemberships(w.albumA, { sort: "taken-desc", limit: 100 }),
    membersB: await repos.albums.listMemberships(w.albumB, { sort: "taken-desc", limit: 100 }),
    sharesA: await repos.shares.listForAlbum(w.albumA),
    sharesB: await repos.shares.listForAlbum(w.albumB),
    sharesC: await repos.shares.listForAlbum(w.albumC),
    usage: await repos.usage.get(w.alice),
    places: await repos.places.list(w.alice),
    profile: await repos.usernames.getProfile(w.alice),
    bobShared: await repos.shares.listForRecipient(w.bob, { limit: 100 }),
    malloryShared: await repos.shares.listForRecipient(w.mallory, { limit: 100 }),
    bobInvited: await repos.shares.listInvitations(w.bob, { limit: 100 }),
  };
}
let before: Awaited<ReturnType<typeof snapshot>>;

interface Request {
  as: string;
  method: string;
  path: string;
  body?: unknown;
}

interface Case {
  /** The registered route this case covers, e.g. "GET /api/photos/:photoId". */
  route: string;
  name: string;
  /** Uses IDs the caller may not touch. */
  foreign: () => Request;
  /** The same request with those IDs replaced by ones that don't exist. */
  missing: () => Request;
}

const id = () => newId();
const json = (body: unknown) => body;

/** Cases for a stranger (Mallory) and for the recipient (Bob) outside his read-only access. */
const cases: Case[] = [
  // ---- places (13.2) ----
  {
    route: "GET /api/places/:placeId/photos",
    name: "stranger lists photos of a place only the owner has",
    foreign: () => ({ as: w.mallory, method: "GET", path: `/places/${BERLIN[0]!.placeId}/photos` }),
    missing: () => ({ as: w.mallory, method: "GET", path: "/places/city:1/photos" }),
  },
  {
    route: "GET /api/places/:placeId/photos",
    name: "recipient lists the owner's place of a shared photo",
    foreign: () => ({ as: w.bob, method: "GET", path: `/places/${BERLIN[2]!.placeId}/photos` }),
    missing: () => ({ as: w.bob, method: "GET", path: "/places/country:ZZ/photos" }),
  },
  // ---- photos ----
  {
    route: "GET /api/photos/:photoId",
    name: "stranger reads a photo",
    foreign: () => ({ as: w.mallory, method: "GET", path: `/photos/${w.p1}` }),
    missing: () => ({ as: w.mallory, method: "GET", path: `/photos/${id()}` }),
  },
  {
    route: "GET /api/photos/:photoId",
    name: "recipient reads a shared photo directly",
    foreign: () => ({ as: w.bob, method: "GET", path: `/photos/${w.p1}` }),
    missing: () => ({ as: w.bob, method: "GET", path: `/photos/${id()}` }),
  },
  {
    route: "GET /api/photos/:photoId",
    name: "stranger reads a photo through an album that isn't shared with her",
    foreign: () => ({ as: w.mallory, method: "GET", path: `/photos/${w.p1}?albumId=${w.albumA}` }),
    missing: () => ({ as: w.mallory, method: "GET", path: `/photos/${id()}?albumId=${id()}` }),
  },
  {
    route: "GET /api/photos/:photoId",
    name: "recipient reads a private photo through the shared album",
    foreign: () => ({ as: w.bob, method: "GET", path: `/photos/${w.p2}?albumId=${w.albumA}` }),
    missing: () => ({ as: w.bob, method: "GET", path: `/photos/${id()}?albumId=${w.albumA}` }),
  },
  {
    route: "GET /api/photos/:photoId/download-url",
    name: "stranger downloads a photo",
    foreign: () => ({ as: w.mallory, method: "GET", path: `/photos/${w.p1}/download-url` }),
    missing: () => ({ as: w.mallory, method: "GET", path: `/photos/${id()}/download-url` }),
  },
  {
    route: "GET /api/photos/:photoId/download-url",
    name: "stranger downloads through an album that isn't shared with her",
    foreign: () => ({
      as: w.mallory,
      method: "GET",
      path: `/photos/${w.p1}/download-url?albumId=${w.albumA}`,
    }),
    missing: () => ({
      as: w.mallory,
      method: "GET",
      path: `/photos/${id()}/download-url?albumId=${id()}`,
    }),
  },
  {
    route: "GET /api/photos/:photoId",
    name: "invitee reads a photo through an album he hasn't accepted (FR-SHR-6)",
    foreign: () => ({ as: w.bob, method: "GET", path: `/photos/${w.p2}?albumId=${w.albumC}` }),
    missing: () => ({ as: w.bob, method: "GET", path: `/photos/${id()}?albumId=${id()}` }),
  },
  {
    route: "GET /api/photos/:photoId/download-url",
    name: "invitee downloads through an album he hasn't accepted (FR-SHR-6)",
    foreign: () => ({
      as: w.bob,
      method: "GET",
      path: `/photos/${w.p2}/download-url?albumId=${w.albumC}`,
    }),
    missing: () => ({
      as: w.bob,
      method: "GET",
      path: `/photos/${id()}/download-url?albumId=${id()}`,
    }),
  },
  {
    route: "GET /api/photos/:photoId/download-url",
    name: "recipient downloads without naming the album",
    foreign: () => ({ as: w.bob, method: "GET", path: `/photos/${w.p1}/download-url` }),
    missing: () => ({ as: w.bob, method: "GET", path: `/photos/${id()}/download-url` }),
  },
  {
    route: "GET /api/photos/:photoId/download-url",
    name: "recipient downloads a private photo through the shared album",
    foreign: () => ({
      as: w.bob,
      method: "GET",
      path: `/photos/${w.p2}/download-url?albumId=${w.albumA}`,
    }),
    missing: () => ({
      as: w.bob,
      method: "GET",
      path: `/photos/${id()}/download-url?albumId=${w.albumA}`,
    }),
  },
  {
    route: "GET /api/photos/:photoId/download-url",
    name: "recipient downloads a pending photo of the shared album",
    foreign: () => ({
      as: w.bob,
      method: "GET",
      path: `/photos/${w.p3}/download-url?albumId=${w.albumA}`,
    }),
    missing: () => ({
      as: w.bob,
      method: "GET",
      path: `/photos/${id()}/download-url?albumId=${w.albumA}`,
    }),
  },
  {
    route: "DELETE /api/photos/:photoId",
    name: "stranger deletes a photo",
    foreign: () => ({ as: w.mallory, method: "DELETE", path: `/photos/${w.p1}` }),
    missing: () => ({ as: w.mallory, method: "DELETE", path: `/photos/${id()}` }),
  },
  {
    route: "DELETE /api/photos/:photoId",
    name: "recipient deletes a shared photo",
    foreign: () => ({ as: w.bob, method: "DELETE", path: `/photos/${w.p1}` }),
    missing: () => ({ as: w.bob, method: "DELETE", path: `/photos/${id()}` }),
  },
  {
    route: "POST /api/photos/upload-url",
    name: "stranger re-signs the upload of someone else's pending photo",
    foreign: () => ({
      as: w.mallory,
      method: "POST",
      path: "/photos/upload-url",
      body: json({ fileName: "x.jpg", contentType: "image/jpeg", sizeBytes: 1000, photoId: w.p3 }),
    }),
    missing: () => ({
      as: w.mallory,
      method: "POST",
      path: "/photos/upload-url",
      body: json({ fileName: "x.jpg", contentType: "image/jpeg", sizeBytes: 1000, photoId: id() }),
    }),
  },

  // ---- albums ----
  {
    route: "PATCH /api/albums/:albumId",
    name: "stranger renames an album",
    foreign: () => ({
      as: w.mallory,
      method: "PATCH",
      path: `/albums/${w.albumA}`,
      body: { name: "x" },
    }),
    missing: () => ({
      as: w.mallory,
      method: "PATCH",
      path: `/albums/${id()}`,
      body: { name: "x" },
    }),
  },
  {
    route: "PATCH /api/albums/:albumId",
    name: "stranger probes an album's photos via the cover",
    foreign: () => ({
      as: w.mallory,
      method: "PATCH",
      path: `/albums/${w.albumA}`,
      body: { coverPhotoId: w.p1 },
    }),
    missing: () => ({
      as: w.mallory,
      method: "PATCH",
      path: `/albums/${id()}`,
      body: { coverPhotoId: id() },
    }),
  },
  {
    route: "PATCH /api/albums/:albumId",
    name: "recipient renames the shared album",
    foreign: () => ({
      as: w.bob,
      method: "PATCH",
      path: `/albums/${w.albumA}`,
      body: { name: "x" },
    }),
    missing: () => ({ as: w.bob, method: "PATCH", path: `/albums/${id()}`, body: { name: "x" } }),
  },
  {
    route: "DELETE /api/albums/:albumId",
    name: "stranger deletes an album",
    foreign: () => ({ as: w.mallory, method: "DELETE", path: `/albums/${w.albumB}` }),
    missing: () => ({ as: w.mallory, method: "DELETE", path: `/albums/${id()}` }),
  },
  {
    route: "DELETE /api/albums/:albumId",
    name: "recipient deletes the shared album",
    foreign: () => ({ as: w.bob, method: "DELETE", path: `/albums/${w.albumA}` }),
    missing: () => ({ as: w.bob, method: "DELETE", path: `/albums/${id()}` }),
  },
  {
    route: "GET /api/albums/:albumId/photos",
    name: "stranger lists an album's photos",
    foreign: () => ({ as: w.mallory, method: "GET", path: `/albums/${w.albumA}/photos` }),
    missing: () => ({ as: w.mallory, method: "GET", path: `/albums/${id()}/photos` }),
  },
  {
    route: "GET /api/albums/:albumId/photos",
    name: "recipient lists an album that isn't shared with him",
    foreign: () => ({ as: w.bob, method: "GET", path: `/albums/${w.albumB}/photos` }),
    missing: () => ({ as: w.bob, method: "GET", path: `/albums/${id()}/photos` }),
  },
  {
    route: "GET /api/albums/:albumId/photos",
    name: "invitee lists an album he hasn't accepted (FR-SHR-6)",
    foreign: () => ({ as: w.bob, method: "GET", path: `/albums/${w.albumC}/photos` }),
    missing: () => ({ as: w.bob, method: "GET", path: `/albums/${id()}/photos` }),
  },
  {
    route: "POST /api/albums/:albumId/photos",
    name: "stranger adds her photo to someone else's album",
    foreign: () => ({
      as: w.mallory,
      method: "POST",
      path: `/albums/${w.albumA}/photos`,
      body: { photoIds: [w.malloryPhoto] },
    }),
    missing: () => ({
      as: w.mallory,
      method: "POST",
      path: `/albums/${id()}/photos`,
      body: { photoIds: [w.malloryPhoto] },
    }),
  },
  {
    route: "POST /api/albums/:albumId/photos",
    name: "stranger adds someone else's photo to her own album",
    foreign: () => ({
      as: w.mallory,
      method: "POST",
      path: `/albums/${w.malloryAlbum}/photos`,
      body: { photoIds: [w.p1] },
    }),
    missing: () => ({
      as: w.mallory,
      method: "POST",
      path: `/albums/${w.malloryAlbum}/photos`,
      body: { photoIds: [id()] },
    }),
  },
  {
    route: "POST /api/albums/:albumId/photos",
    name: "recipient adds a photo to the shared album",
    foreign: () => ({
      as: w.bob,
      method: "POST",
      path: `/albums/${w.albumA}/photos`,
      body: { photoIds: [w.p2] },
    }),
    missing: () => ({
      as: w.bob,
      method: "POST",
      path: `/albums/${id()}/photos`,
      body: { photoIds: [id()] },
    }),
  },
  {
    route: "DELETE /api/albums/:albumId/photos/:photoId",
    name: "stranger removes a photo from an album",
    foreign: () => ({
      as: w.mallory,
      method: "DELETE",
      path: `/albums/${w.albumA}/photos/${w.p1}`,
    }),
    missing: () => ({ as: w.mallory, method: "DELETE", path: `/albums/${id()}/photos/${id()}` }),
  },
  {
    route: "DELETE /api/albums/:albumId/photos/:photoId",
    name: "recipient removes a photo from the shared album",
    foreign: () => ({ as: w.bob, method: "DELETE", path: `/albums/${w.albumA}/photos/${w.p1}` }),
    missing: () => ({ as: w.bob, method: "DELETE", path: `/albums/${id()}/photos/${id()}` }),
  },

  // ---- shares ----
  {
    route: "GET /api/albums/:albumId/shares",
    name: "stranger lists an album's shares",
    foreign: () => ({ as: w.mallory, method: "GET", path: `/albums/${w.albumA}/shares` }),
    missing: () => ({ as: w.mallory, method: "GET", path: `/albums/${id()}/shares` }),
  },
  {
    route: "GET /api/albums/:albumId/shares",
    name: "recipient lists the shared album's shares",
    foreign: () => ({ as: w.bob, method: "GET", path: `/albums/${w.albumA}/shares` }),
    missing: () => ({ as: w.bob, method: "GET", path: `/albums/${id()}/shares` }),
  },
  {
    route: "POST /api/albums/:albumId/shares",
    name: "stranger shares someone else's album with herself",
    foreign: () => ({
      as: w.mallory,
      method: "POST",
      path: `/albums/${w.albumB}/shares`,
      body: { email: "mallory@example.com" },
    }),
    missing: () => ({
      as: w.mallory,
      method: "POST",
      path: `/albums/${id()}/shares`,
      body: { email: "mallory@example.com" },
    }),
  },
  {
    route: "POST /api/albums/:albumId/shares",
    name: "recipient re-shares the shared album (FR-SHR-4)",
    foreign: () => ({
      as: w.bob,
      method: "POST",
      path: `/albums/${w.albumA}/shares`,
      body: { email: "mallory@example.com" },
    }),
    missing: () => ({
      as: w.bob,
      method: "POST",
      path: `/albums/${id()}/shares`,
      body: { email: "mallory@example.com" },
    }),
  },
  {
    route: "DELETE /api/albums/:albumId/shares/:userId",
    name: "stranger revokes someone's share",
    foreign: () => ({
      as: w.mallory,
      method: "DELETE",
      path: `/albums/${w.albumA}/shares/${w.bob}`,
    }),
    missing: () => ({
      as: w.mallory,
      method: "DELETE",
      path: `/albums/${id()}/shares/${newUserId()}`,
    }),
  },
  {
    route: "DELETE /api/albums/:albumId/shares/:userId",
    name: "recipient revokes his own share",
    foreign: () => ({ as: w.bob, method: "DELETE", path: `/albums/${w.albumA}/shares/${w.bob}` }),
    missing: () => ({ as: w.bob, method: "DELETE", path: `/albums/${id()}/shares/${w.bob}` }),
  },

  // ---- the recipient's side of shares (FR-SHR-6/7): only the caller's own share counts ----
  {
    route: "POST /api/shared-albums/:albumId/accept",
    name: "stranger accepts an invitation addressed to someone else",
    foreign: () => ({ as: w.mallory, method: "POST", path: `/shared-albums/${w.albumC}/accept` }),
    missing: () => ({ as: w.mallory, method: "POST", path: `/shared-albums/${id()}/accept` }),
  },
  {
    route: "POST /api/shared-albums/:albumId/accept",
    name: "owner accepts her own album's invitation",
    foreign: () => ({ as: w.alice, method: "POST", path: `/shared-albums/${w.albumC}/accept` }),
    missing: () => ({ as: w.alice, method: "POST", path: `/shared-albums/${id()}/accept` }),
  },
  {
    route: "DELETE /api/shared-albums/:albumId",
    name: "stranger removes someone else's share",
    foreign: () => ({ as: w.mallory, method: "DELETE", path: `/shared-albums/${w.albumA}` }),
    missing: () => ({ as: w.mallory, method: "DELETE", path: `/shared-albums/${id()}` }),
  },
  {
    route: "DELETE /api/shared-albums/:albumId",
    name: "owner removes her own album as if shared with her",
    foreign: () => ({ as: w.alice, method: "DELETE", path: `/shared-albums/${w.albumA}` }),
    missing: () => ({ as: w.alice, method: "DELETE", path: `/shared-albums/${id()}` }),
  },
];

/**
 * Routes that take no resource IDs: they only ever read or write the caller's own data (their
 * repository calls are keyed by the JWT `sub`), so there is nothing foreign to pass. Their
 * "only my data" behaviour is checked below.
 */
const exempt: Record<string, string> = {
  "GET /api/health": "public, no data",
  "GET /api/me": "caller's own profile and usage",
  "PUT /api/me/username": "caller's own username (uniqueness: 409, tested in routes.usernames)",
  "GET /api/photos": "caller's gallery; foreign cursor case below",
  "GET /api/albums": "caller's albums",
  "POST /api/albums": "creates under the caller",
  "GET /api/shared-albums": "caller's shares; foreign cursor case below",
  "GET /api/share-invitations": "caller's invitations; foreign cursor case below",
  "GET /api/places": "caller's own places (keyed by sub); checked below",
  "GET /api/places/map": "caller's own photos with GPS (keyed by sub); checked below",
  "POST /api/session/media-cookie": "caller's own prefix from the JWT sub (routes.session)",
  "DELETE /api/session/media-cookie": "caller's own prefix from the JWT sub (routes.session)",
};

async function send(r: Request) {
  return t.api(r.as, r.method, r.path, r.body);
}

describe("route coverage", () => {
  test("every registered route has an isolation case or an explicit exemption", () => {
    const registered = new Set(
      t.app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`),
    );
    const covered = new Set([...cases.map((c) => c.route), ...Object.keys(exempt)]);
    expect([...registered].filter((route) => !covered.has(route)).sort()).toEqual([]);
    // And no case points at a route that doesn't exist (a typo would silently test nothing).
    expect([...covered].filter((route) => !registered.has(route)).sort()).toEqual([]);
  });
});

describe("foreign IDs answer exactly like missing ones (NFR-SEC-2)", () => {
  test.each(cases.map((c) => [`${c.route}: ${c.name}`, c] as const))("%s", async (_, c) => {
    const foreign = await send(c.foreign());
    const missing = await send(c.missing());
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(missing);
  });
});

describe("list routes only return the caller's data", () => {
  test("gallery, albums and shared albums of a stranger contain nothing of Alice's", async () => {
    const photos = photoPageSchema.parse((await t.api(w.mallory, "GET", "/photos")).body);
    expect(photos.items.map((p) => p.photoId)).toEqual([w.malloryPhoto]);

    const albums = (await t.api(w.mallory, "GET", "/albums")).body as {
      items: { albumId: string }[];
    };
    expect(albums.items.map((a) => a.albumId)).toEqual([w.malloryAlbum]);

    const shared = sharedAlbumPageSchema.parse(
      (await t.api(w.mallory, "GET", "/shared-albums")).body,
    );
    expect(shared.items).toEqual([]);
    const invited = shareInvitationPageSchema.parse(
      (await t.api(w.mallory, "GET", "/share-invitations")).body,
    );
    expect(invited.items).toEqual([]);
  });

  test("places are the owner's: a stranger and the recipient have none of Alice's", async () => {
    expect((await t.api(w.mallory, "GET", "/places")).body).toEqual({ items: [] });
    expect((await t.api(w.bob, "GET", "/places")).body).toEqual({ items: [] });
    const own = (await t.api(w.alice, "GET", "/places")).body as { items: { placeId: string }[] };
    expect(own.items.map((p) => p.placeId).sort()).toEqual(BERLIN.map((p) => p.placeId).sort());
  });

  test("map pins are the owner's: a stranger and the recipient get none of Alice's (13.2h)", async () => {
    expect((await t.api(w.mallory, "GET", "/places/map")).body).toEqual({ items: [] });
    expect((await t.api(w.bob, "GET", "/places/map")).body).toEqual({ items: [] });
    const own = (await t.api(w.alice, "GET", "/places/map")).body as {
      items: { photoId: string }[];
    };
    expect(own.items.map((p) => p.photoId).sort()).toEqual([w.p1, w.p2].sort());
  });

  test("a shared photo comes without its place (13.2g)", async () => {
    const shared = photoPageSchema.parse(
      (await t.api(w.bob, "GET", `/albums/${w.albumA}/photos`)).body,
    );
    expect(shared.items.map((p) => [p.photoId, p.place])).toEqual([[w.p1, null]]);
    const one = (await t.api(w.bob, "GET", `/photos/${w.p1}?albumId=${w.albumA}`)).body as {
      place: unknown;
    };
    expect(one.place).toBeNull();
  });

  test("the recipient's own gallery and albums don't include shared ones", async () => {
    expect(photoPageSchema.parse((await t.api(w.bob, "GET", "/photos")).body).items).toEqual([]);
    expect((await t.api(w.bob, "GET", "/albums")).body).toEqual({ items: [] });
    const shared = sharedAlbumPageSchema.parse((await t.api(w.bob, "GET", "/shared-albums")).body);
    expect(shared.items.map((a) => a.albumId)).toEqual([w.albumA]);
    // The invitation is listed apart, without a cover (FR-SHR-6).
    const invited = shareInvitationPageSchema.parse(
      (await t.api(w.bob, "GET", "/share-invitations")).body,
    );
    expect(invited.items.map((a) => a.albumId)).toEqual([w.albumC]);
    expect(invited.items[0]).not.toHaveProperty("coverThumbUrl");
  });

  test("another user's cursor is rejected on every paginated route", async () => {
    for (const path of [
      `/photos?cursor=${w.aliceCursor}`,
      `/albums/${w.malloryAlbum}/photos?cursor=${w.aliceCursor}`,
      `/shared-albums?cursor=${w.aliceCursor}`,
      `/share-invitations?cursor=${w.aliceCursor}`,
    ]) {
      const res = await t.api(w.mallory, "GET", path);
      expect(res.status, path).toBe(400);
      expect(res.body).toEqual({ error: { code: "VALIDATION_ERROR", message: "Invalid cursor" } });
    }
  });

  test("GET /me shows only the caller's own profile and usage", async () => {
    const me = (await t.api(w.mallory, "GET", "/me")).body as { userId: string; email: string };
    expect(me).toMatchObject({ userId: w.mallory, email: "mallory@example.com" });
  });
});

describe("nothing changed", () => {
  // Runs last (tests in a file run in order): every attempt above must have been harmless.
  test("Alice's photos, albums, memberships, shares, usage and username are untouched", async () => {
    expect(await snapshot()).toEqual(before);
  });

  test("no S3 object was signed for or deleted", () => {
    expect(t.downloads).toEqual([]);
    expect(t.deletes).toEqual([]);
    expect(t.uploads.filter((u) => u.key.includes(w.alice))).toEqual([]);
  });
});
