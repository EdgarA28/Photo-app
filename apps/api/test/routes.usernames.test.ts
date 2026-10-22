/** Usernames and sharing by username (5.15, FR-ACC-3, FR-SHR-5, D-8) on DynamoDB Local. */
import {
  USERNAME_HOLD_DAYS,
  albumShareListSchema,
  albumShareSchema,
  apiErrorSchema,
  meResponseSchema,
  newId,
  sharedAlbumPageSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Repositories } from "../src/repo";
import { createTestApi, newUserId, nextIso } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let repos: Repositories;
let api: TestApi["api"];
let profiles: TestApi["profiles"];
beforeAll(async () => {
  ({ repos, api, profiles } = await createTestApi());
});

function errorCode(body: unknown) {
  return apiErrorSchema.parse(body).error.code;
}

/** Unique per test, so tests on one table don't collide. */
let counter = 0;
const uniqueName = (base = "user") => `${base}_${Date.now().toString(36)}${counter++}`;

const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString();

function register() {
  const userId = newUserId();
  profiles.set(userId, { email: `u-${userId.slice(0, 8)}@example.com`, name: null });
  return userId;
}

describe("usernames repository", () => {
  test("claim, rename, and the old name held for its former owner (D-8)", async () => {
    const [ana, bruno] = [newUserId(), newUserId()];
    const [first, second] = [uniqueName("ana"), uniqueName("ana")];
    const t0 = Date.parse("2026-11-01T00:00:00.000Z");

    expect(await repos.usernames.set(ana, first, at(t0))).toBe("ok");
    expect(await repos.usernames.set(ana, first, at(t0))).toBe("unchanged");
    expect(await repos.usernames.findUser(first)).toBe(ana);
    expect(await repos.usernames.getProfile(ana)).toEqual({
      userId: ana,
      username: first,
      usernameChangedAt: at(t0),
    });

    expect(await repos.usernames.set(ana, second, at(t0 + DAY))).toBe("ok");
    expect(await repos.usernames.findUser(second)).toBe(ana);
    // Held: nobody can be reached under it, and nobody else can claim it…
    expect(await repos.usernames.findUser(first)).toBeNull();
    expect(await repos.usernames.set(bruno, first, at(t0 + 2 * DAY))).toBe("taken");
    // …until the hold is over.
    const afterHold = t0 + DAY + USERNAME_HOLD_DAYS * DAY + 1;
    expect(await repos.usernames.set(bruno, first, at(afterHold))).toBe("ok");
    expect(await repos.usernames.findUser(first)).toBe(bruno);
  });

  test("the former owner can take their held name back", async () => {
    const ana = newUserId();
    const [first, second] = [uniqueName("ana"), uniqueName("ana")];
    await repos.usernames.set(ana, first, nextIso());
    await repos.usernames.set(ana, second, nextIso());

    expect(await repos.usernames.set(ana, first, nextIso())).toBe("ok");
    expect(await repos.usernames.findUser(first)).toBe(ana);
    // And now the other one is held instead.
    expect(await repos.usernames.findUser(second)).toBeNull();
    expect(await repos.usernames.set(newUserId(), second, nextIso())).toBe("taken");
  });

  test("an active name can't be taken; two users racing for one name: exactly one wins", async () => {
    const name = uniqueName();
    const users = Array.from({ length: 5 }, () => newUserId());
    const results = await Promise.all(users.map((u) => repos.usernames.set(u, name, nextIso())));

    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "taken")).toHaveLength(4);
    const winner = users[results.indexOf("ok")];
    expect(await repos.usernames.findUser(name)).toBe(winner);
    // The losers got no profile.
    for (const [i, u] of users.entries()) {
      if (results[i] === "taken") expect(await repos.usernames.getProfile(u)).toBeNull();
    }
  });

  test("one user renaming twice at once ends with exactly one active name", async () => {
    const ana = newUserId();
    await repos.usernames.set(ana, uniqueName(), nextIso());
    const [x, y] = [uniqueName("x"), uniqueName("y")];
    const results = await Promise.all([
      repos.usernames.set(ana, x, nextIso()),
      repos.usernames.set(ana, y, nextIso()),
    ]);

    expect(results).toEqual(["ok", "ok"]);
    const current = (await repos.usernames.getProfile(ana))!.username;
    const other = current === x ? y : x;
    expect(await repos.usernames.findUser(current)).toBe(ana);
    expect(await repos.usernames.findUser(other)).toBeNull();
  });

  test("getMany: current usernames, users without one left out", async () => {
    const [a, b, none] = [newUserId(), newUserId(), newUserId()];
    const [na, nb] = [uniqueName(), uniqueName()];
    await repos.usernames.set(a, na, nextIso());
    await repos.usernames.set(b, nb, nextIso());

    expect(await repos.usernames.getMany([a, b, none, a])).toEqual(
      new Map([
        [a, na],
        [b, nb],
      ]),
    );
    expect(await repos.usernames.getMany([])).toEqual(new Map());
  });
});

describe("PUT /me/username (FR-ACC-3)", () => {
  test("sets the normalised name; GET /me shows it", async () => {
    const me = register();
    const name = uniqueName("ana");

    const res = await api(me, "PUT", "/me/username", { username: `  @${name.toUpperCase()} ` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: name });
    expect(meResponseSchema.parse((await api(me, "GET", "/me")).body).username).toBe(name);
  });

  test("same name again → 200; rename → 200 and GET /me follows", async () => {
    const me = register();
    const [first, second] = [uniqueName(), uniqueName()];
    await api(me, "PUT", "/me/username", { username: first });

    expect((await api(me, "PUT", "/me/username", { username: first })).status).toBe(200);
    expect((await api(me, "PUT", "/me/username", { username: second })).status).toBe(200);
    expect(meResponseSchema.parse((await api(me, "GET", "/me")).body).username).toBe(second);
  });

  test("someone else's name, or a name held for someone else → 409 USERNAME_TAKEN", async () => {
    const [ana, bruno] = [register(), register()];
    const [first, second] = [uniqueName(), uniqueName()];
    await api(ana, "PUT", "/me/username", { username: first });

    const taken = await api(bruno, "PUT", "/me/username", { username: first });
    expect(taken.status).toBe(409);
    expect(errorCode(taken.body)).toBe("USERNAME_TAKEN");

    await api(ana, "PUT", "/me/username", { username: second });
    const held = await api(bruno, "PUT", "/me/username", { username: first });
    expect(held.status).toBe(409);
    expect(errorCode(held.body)).toBe("USERNAME_TAKEN");
  });

  test("invalid or reserved → 400 VALIDATION_ERROR; anonymous → 401", async () => {
    const me = register();
    for (const username of ["ab", "ana r", "an..a", "admin", "аna"]) {
      const res = await api(me, "PUT", "/me/username", { username });
      expect(res.status).toBe(400);
      expect(errorCode(res.body)).toBe("VALIDATION_ERROR");
    }
    expect((await api(null, "PUT", "/me/username", { username: uniqueName() })).status).toBe(401);
  });
});

describe("sharing by username (FR-SHR-5)", () => {
  async function albumOf(ownerId: string) {
    return repos.albums.create({ ownerId, albumId: newId(), name: "Lisbon", createdAt: nextIso() });
  }

  test("shares with the user who has the name; the owner never sees their email", async () => {
    const [owner, friend] = [register(), register()];
    const name = uniqueName("ana");
    await api(friend, "PUT", "/me/username", { username: name });
    const album = await albumOf(owner);

    const res = await api(owner, "POST", `/albums/${album.albumId}/shares`, {
      username: `@${name.toUpperCase()}`,
    });

    expect(res.status).toBe(201);
    expect(albumShareSchema.parse(res.body)).toMatchObject({
      userId: friend,
      email: null,
      username: name,
    });
    const list = albumShareListSchema.parse(
      (await api(owner, "GET", `/albums/${album.albumId}/shares`)).body,
    );
    expect(list.items).toEqual([expect.objectContaining({ userId: friend, email: null })]);
    // Not stored either.
    expect((await repos.shares.get(album.albumId, friend))?.email).toBeUndefined();
  });

  test("unknown or held name → 404 SHARE_TARGET_NOT_FOUND; own name → 400", async () => {
    const [owner, friend] = [register(), register()];
    const [old, current, mine] = [uniqueName(), uniqueName(), uniqueName()];
    await api(friend, "PUT", "/me/username", { username: old });
    await api(friend, "PUT", "/me/username", { username: current });
    await api(owner, "PUT", "/me/username", { username: mine });
    const album = await albumOf(owner);
    const path = `/albums/${album.albumId}/shares`;

    for (const username of [uniqueName("nobody"), old]) {
      const res = await api(owner, "POST", path, { username });
      expect(res.status).toBe(404);
      expect(errorCode(res.body)).toBe("SHARE_TARGET_NOT_FOUND");
    }
    const self = await api(owner, "POST", path, { username: mine });
    expect(self.status).toBe(400);
    expect(await repos.shares.listForAlbum(album.albumId)).toEqual([]);
  });

  test("someone else's album → 404 NOT_FOUND before the name lookup", async () => {
    const [owner, intruder, friend] = [register(), register(), register()];
    const name = uniqueName();
    await api(friend, "PUT", "/me/username", { username: name });
    const album = await albumOf(owner);

    for (const username of [name, uniqueName("nobody")]) {
      const res = await api(intruder, "POST", `/albums/${album.albumId}/shares`, { username });
      expect(res.status).toBe(404);
      expect(errorCode(res.body)).toBe("NOT_FOUND");
    }
  });

  test("shares made by email show the email and the current username", async () => {
    const [owner, friend] = [register(), register()];
    const name = uniqueName();
    await api(friend, "PUT", "/me/username", { username: name });
    const album = await albumOf(owner);

    const res = await api(owner, "POST", `/albums/${album.albumId}/shares`, {
      email: profiles.get(friend)!.email,
    });
    expect(albumShareSchema.parse(res.body)).toMatchObject({
      email: profiles.get(friend)!.email,
      username: name,
    });
  });

  test("a rename shows up in share lists and shared albums; the share keeps working", async () => {
    const [owner, friend] = [register(), register()];
    const [ownerName, friendOld, friendNew] = [uniqueName("o"), uniqueName("f"), uniqueName("f")];
    await api(owner, "PUT", "/me/username", { username: ownerName });
    await api(friend, "PUT", "/me/username", { username: friendOld });
    const album = await albumOf(owner);
    await api(owner, "POST", `/albums/${album.albumId}/shares`, { username: friendOld });

    await api(friend, "PUT", "/me/username", { username: friendNew });
    const list = albumShareListSchema.parse(
      (await api(owner, "GET", `/albums/${album.albumId}/shares`)).body,
    );
    expect(list.items[0]?.username).toBe(friendNew);

    const shared = sharedAlbumPageSchema.parse((await api(friend, "GET", "/shared-albums")).body);
    expect(shared.items).toEqual([
      expect.objectContaining({ albumId: album.albumId, ownerUsername: ownerName }),
    ]);
    expect((await api(friend, "GET", `/albums/${album.albumId}/photos`)).status).toBe(200);
  });

  test("owners without a username show as null in Shared with me", async () => {
    const [owner, friend] = [register(), register()];
    const album = await albumOf(owner);
    await api(owner, "POST", `/albums/${album.albumId}/shares`, {
      email: profiles.get(friend)!.email,
    });
    const shared = sharedAlbumPageSchema.parse((await api(friend, "GET", "/shared-albums")).body);
    expect(shared.items[0]?.ownerUsername).toBeNull();
  });

  test("both email and username, or neither → 400", async () => {
    const owner = register();
    const album = await albumOf(owner);
    const path = `/albums/${album.albumId}/shares`;
    expect((await api(owner, "POST", path, {})).status).toBe(400);
    expect(
      (await api(owner, "POST", path, { email: "a@b.co", username: uniqueName() })).status,
    ).toBe(400);
  });
});
