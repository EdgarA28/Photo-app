/**
 * "Save to my gallery" for photos of an album shared with me (FR-SHR-10):
 * POST /shared-albums/{albumId}/save copies originals into the recipient's own library.
 */
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_PHOTOS_PER_SAVE_REQUEST,
  newId,
  saveSharedPhotosResponseSchema,
  type SaveSharedPhotosResponse,
} from "@photo-app/shared";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db, PhotoRecord, Repositories } from "../src/repo";
import { createPending, createTestApi, markReady, newPhoto, newUserId, nextIso } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let db: Db;
let repos: Repositories;
let api: TestApi["api"];
let copies: TestApi["copies"];
let hooks: TestApi["hooks"];
beforeAll(async () => {
  ({ db, repos, api, copies, hooks } = await createTestApi());
});
beforeEach(() => {
  copies.length = 0;
  delete hooks.onCopy;
});

async function readyPhoto(userId: string, sizeBytes = 1000): Promise<PhotoRecord> {
  const photo = await createPending(repos, newPhoto(userId, { sizeBytes }));
  await markReady(db, userId, photo.photoId, sizeBytes, "2025-06-01T12:00:00.000Z");
  return (await repos.photos.get(userId, photo.photoId))!;
}

/** Owner's album with a ready and a pending photo, shared with `friend` (accepted). */
async function setup(status: "accepted" | "pending" = "accepted") {
  const owner = newUserId();
  const friend = newUserId();
  const album = await repos.albums.create({
    ownerId: owner,
    albumId: newId(),
    name: "Holidays",
    createdAt: nextIso(),
  });
  const ready = await readyPhoto(owner, 4000);
  const second = await readyPhoto(owner, 3000);
  const pending = await createPending(repos, newPhoto(owner));
  const outside = await readyPhoto(owner);
  await repos.albums.addPhotos(
    owner,
    album.albumId,
    [ready.photoId, second.photoId, pending.photoId],
    nextIso(),
  );
  await repos.shares.create({
    albumId: album.albumId,
    ownerId: owner,
    userId: friend,
    email: "friend@example.com",
    status,
    sharedAt: nextIso(),
  });
  return { owner, friend, albumId: album.albumId, ready, second, pending, outside };
}

async function save(as: string, albumId: string, photoIds: string[]) {
  const res = await api(as, "POST", `/shared-albums/${albumId}/save`, { photoIds });
  return {
    status: res.status,
    items: res.status === 200 ? saveSharedPhotosResponseSchema.parse(res.body).items : [],
  };
}

const only = (items: SaveSharedPhotosResponse["items"]) => {
  expect(items).toHaveLength(1);
  return items[0]!;
};

describe("POST /shared-albums/{albumId}/save (FR-SHR-10)", () => {
  test("copies the original into my library as a new pending photo, reserving my quota", async () => {
    const { owner, friend, albumId, ready } = await setup();
    const ownersBefore = await repos.photos.get(owner, ready.photoId);

    const { status, items } = await save(friend, albumId, [ready.photoId]);

    expect(status).toBe(200);
    const item = only(items);
    expect(item).toMatchObject({ photoId: ready.photoId, result: "saved", inTrash: false });
    const copy = (await repos.photos.get(friend, item.savedPhotoId!))!;
    expect(copy).toMatchObject({
      userId: friend,
      status: "pending",
      fileName: ready.fileName,
      contentType: ready.contentType,
      sizeBytes: 4000,
      originalKey: `users/${friend}/originals/${item.savedPhotoId}.jpg`,
    });
    expect(copies).toEqual([{ from: ready.originalKey, to: copy.originalKey }]);
    expect(await repos.usage.get(friend)).toMatchObject({ bytesReserved: 4000 });
    // The owner's photo and usage are untouched.
    expect(await repos.photos.get(owner, ready.photoId)).toEqual(ownersBefore);
  });

  test("saving the same photo again answers with my copy, without copying it twice", async () => {
    const { friend, albumId, ready } = await setup();
    const first = only((await save(friend, albumId, [ready.photoId])).items);
    await markReady(db, friend, first.savedPhotoId!, 4000, "2025-06-01T12:00:00.000Z");
    copies.length = 0;

    const again = only((await save(friend, albumId, [ready.photoId])).items);

    expect(again).toEqual({
      photoId: ready.photoId,
      result: "already-saved",
      savedPhotoId: first.savedPhotoId,
      inTrash: false,
    });
    expect(copies).toEqual([]);
    expect(await repos.usage.get(friend)).toMatchObject({ bytesUsed: 4000, photoCount: 1 });
  });

  test("a copy in my trash is still 'already saved'; deleted for good, it can be saved anew", async () => {
    const { friend, albumId, ready } = await setup();
    const first = only((await save(friend, albumId, [ready.photoId])).items);
    await markReady(db, friend, first.savedPhotoId!, 4000, "2025-06-01T12:00:00.000Z");
    await repos.photos.trash(friend, first.savedPhotoId!, new Date());

    expect(only((await save(friend, albumId, [ready.photoId])).items)).toMatchObject({
      result: "already-saved",
      savedPhotoId: first.savedPhotoId,
      inTrash: true,
    });

    expect((await api(friend, "DELETE", `/trash/${first.savedPhotoId}`)).status).toBe(204);
    const anew = only((await save(friend, albumId, [ready.photoId])).items);
    expect(anew.result).toBe("saved");
    expect(anew.savedPhotoId).not.toBe(first.savedPhotoId);
    expect(only((await save(friend, albumId, [ready.photoId])).items)).toMatchObject({
      savedPhotoId: anew.savedPhotoId,
    });
  });

  test("a failed copy leaves the pending photo, and a retry copies into that same photo", async () => {
    const { friend, albumId, ready } = await setup();
    hooks.onCopy = async () => {
      throw new Error("S3 is down");
    };
    expect((await save(friend, albumId, [ready.photoId])).status).toBe(500);
    delete hooks.onCopy;

    const retry = only((await save(friend, albumId, [ready.photoId])).items);

    expect(retry.result).toBe("saved");
    const page = await repos.photos.list(friend, { sort: "taken-desc", limit: 10 });
    expect(page.items.map((photo) => photo.photoId)).toEqual([retry.savedPhotoId]);
    expect(copies).toEqual([
      { from: ready.originalKey, to: `users/${friend}/originals/${retry.savedPhotoId}.jpg` },
    ]);
    expect(await repos.usage.get(friend)).toMatchObject({ bytesReserved: 4000 });
  });

  test("several photos, in request order; unprocessed, foreign and unknown ones are unavailable", async () => {
    const { friend, albumId, ready, second, pending, outside } = await setup();
    const unknown = newId();

    const { items } = await save(friend, albumId, [
      second.photoId,
      pending.photoId,
      outside.photoId,
      unknown,
      ready.photoId,
    ]);

    expect(items.map((item) => [item.photoId, item.result])).toEqual([
      [second.photoId, "saved"],
      [pending.photoId, "unavailable"],
      [outside.photoId, "unavailable"],
      [unknown, "unavailable"],
      [ready.photoId, "saved"],
    ]);
    expect(copies).toHaveLength(2);
    expect(await repos.usage.get(friend)).toMatchObject({ bytesReserved: 7000 });
  });

  test("the same photo twice in one request is saved once", async () => {
    const { friend, albumId, ready } = await setup();
    const { items } = await save(friend, albumId, [ready.photoId, ready.photoId]);
    expect(only(items).result).toBe("saved");
    expect(copies).toHaveLength(1);
  });

  test("photos that don't fit in my quota are not saved", async () => {
    const { friend, albumId, ready, second } = await setup();
    await db.client.send(
      new PutCommand({
        TableName: db.table,
        Item: {
          PK: `USER#${friend}`,
          SK: "USAGE",
          bytesUsed: 0,
          bytesReserved: 0,
          photoCount: 0,
          // Only the 3000-byte photo fits, whichever of the two is copied first.
          quotaBytes: 3500,
        },
      }),
    );

    const { items } = await save(friend, albumId, [ready.photoId, second.photoId]);

    expect(items.map((item) => item.result)).toEqual(["quota-exceeded", "saved"]);
    expect(await repos.usage.get(friend)).toMatchObject({ bytesReserved: 3000 });
  });

  test("survives pending items clashing on Usage (TransactionConflict)", async () => {
    const { friend, albumId, ready, second } = await setup();
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
      const { items } = await save(friend, albumId, [ready.photoId, second.photoId]);
      expect(items.map((item) => item.result)).toEqual(["saved", "saved"]);
    } finally {
      spy.mockRestore();
    }
    expect(conflicts).toBe(2);
    expect(await repos.usage.get(friend)).toMatchObject({ bytesReserved: 7000 });
  });

  test("only for accepted shares: invitations, the owner and strangers get 404", async () => {
    const invited = await setup("pending");
    expect((await save(invited.friend, invited.albumId, [invited.ready.photoId])).status).toBe(404);

    const { owner, friend, albumId, ready } = await setup();
    expect((await save(owner, albumId, [ready.photoId])).status).toBe(404);
    expect((await save(newUserId(), albumId, [ready.photoId])).status).toBe(404);

    await repos.shares.delete(albumId, friend);
    expect((await save(friend, albumId, [ready.photoId])).status).toBe(404);
    expect(copies).toEqual([]);
  });

  test("validation: 1 to MAX photo IDs; anonymous → 401", async () => {
    const { friend, albumId, ready } = await setup();
    const tooMany = Array.from({ length: MAX_PHOTOS_PER_SAVE_REQUEST + 1 }, () => newId());
    expect((await save(friend, albumId, [])).status).toBe(400);
    expect((await save(friend, albumId, tooMany)).status).toBe(400);
    expect((await save(friend, albumId, ["nope"])).status).toBe(400);
    const anonymous = await api(null, "POST", `/shared-albums/${albumId}/save`, {
      photoIds: [ready.photoId],
    });
    expect(anonymous.status).toBe(401);
  });
});
