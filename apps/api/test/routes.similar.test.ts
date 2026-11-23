/**
 * Similar photos (8.37b, FR-GAL-10/11, spec §8.2, §9): `similarityHash`, `sharpness` and
 * `topPickAt` in own photo lists, never for share recipients, and POST /photos/{id}/top-pick.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { newId, photoPageSchema, photoSchema } from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Db, Repositories } from "../src/repo";
import { createPending, createTestApi, markReady, newPhoto, newUserId, nextIso } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let db: Db;
let repos: Repositories;
let api: TestApi["api"];
beforeAll(async () => {
  ({ db, repos, api } = await createTestApi());
});

const HASH = "f0e1d2c3b4a59687";

async function readyPhoto(userId: string, takenAt = "2025-06-01T12:00:00.000Z") {
  const photo = await createPending(repos, newPhoto(userId));
  await markReady(db, userId, photo.photoId, 1000, takenAt);
  return photo.photoId;
}

/** What the thumbnail Lambda writes in the `ready` update (8.37a). */
async function setSimilarity(userId: string, photoId: string, hash: string, sharpness: number) {
  await db.client.send(
    new UpdateCommand({
      TableName: db.table,
      Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
      UpdateExpression: "SET similarityHash = :h, sharpness = :s",
      ExpressionAttributeValues: { ":h": hash, ":s": sharpness },
    }),
  );
}

async function storedTopPick(userId: string, photoId: string): Promise<unknown> {
  const out = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
      ConsistentRead: true,
    }),
  );
  return out.Item?.topPickAt;
}

describe("similarity fields in own photos", () => {
  test("GET /photos and GET /photos/{id} carry the Lambda's values", async () => {
    const user = newUserId();
    const photoId = await readyPhoto(user);
    await setSimilarity(user, photoId, HASH, 92.45);

    const page = photoPageSchema.parse((await api(user, "GET", "/photos")).body);
    expect(page.items[0]).toMatchObject({
      photoId,
      similarityHash: HASH,
      sharpness: 92.45,
      topPickAt: null,
    });
    const one = photoSchema.parse((await api(user, "GET", `/photos/${photoId}`)).body);
    expect(one).toMatchObject({ similarityHash: HASH, sharpness: 92.45 });
  });

  test("null for photos processed before 8.37 and for pending ones", async () => {
    const user = newUserId();
    await readyPhoto(user);
    await createPending(repos, newPhoto(user));

    const page = photoPageSchema.parse((await api(user, "GET", "/photos")).body);
    expect(page.items).toHaveLength(2);
    for (const photo of page.items) {
      expect(photo).toMatchObject({ similarityHash: null, sharpness: null, topPickAt: null });
    }
  });

  test("share recipients never get them (stacks are the owner's Gallery only)", async () => {
    const owner = newUserId();
    const friend = newUserId();
    const photoId = await readyPhoto(owner);
    await setSimilarity(owner, photoId, HASH, 50);
    expect((await api(owner, "POST", `/photos/${photoId}/top-pick`)).status).toBe(204);
    const album = await repos.albums.create({
      ownerId: owner,
      albumId: newId(),
      name: "Shared",
      createdAt: nextIso(),
    });
    await repos.albums.addPhotos(owner, album.albumId, [photoId], nextIso());
    await repos.shares.create({
      albumId: album.albumId,
      ownerId: owner,
      userId: friend,
      email: "friend@example.com",
      status: "accepted",
      sharedAt: nextIso(),
    });

    const empty = { similarityHash: null, sharpness: null, topPickAt: null };
    const one = await api(friend, "GET", `/photos/${photoId}?albumId=${album.albumId}`);
    expect(photoSchema.parse(one.body)).toMatchObject({ photoId, ...empty });
    const list = await api(friend, "GET", `/albums/${album.albumId}/photos`);
    expect(photoPageSchema.parse(list.body).items).toEqual([
      expect.objectContaining({ photoId, ...empty }),
    ]);
  });
});

describe("POST /photos/{id}/top-pick (FR-GAL-11)", () => {
  test("204, records the time and shows it in the gallery; a later pick is newer", async () => {
    const user = newUserId();
    const first = await readyPhoto(user, "2025-06-01T12:00:00.000Z");
    const second = await readyPhoto(user, "2025-06-01T12:00:02.000Z");

    expect((await api(user, "POST", `/photos/${first}/top-pick`)).status).toBe(204);
    const firstAt = await storedTopPick(user, first);
    expect(typeof firstAt).toBe("string");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await api(user, "POST", `/photos/${second}/top-pick`)).status).toBe(204);

    const page = photoPageSchema.parse((await api(user, "GET", "/photos")).body);
    const picks = new Map(page.items.map((p) => [p.photoId, p.topPickAt]));
    expect(picks.get(first)).toBe(firstAt);
    expect(picks.get(second)! > picks.get(first)!).toBe(true);
  });

  test("picking the same photo again just moves the time", async () => {
    const user = newUserId();
    const photoId = await readyPhoto(user);
    expect((await api(user, "POST", `/photos/${photoId}/top-pick`)).status).toBe(204);
    const before = await storedTopPick(user, photoId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await api(user, "POST", `/photos/${photoId}/top-pick`)).status).toBe(204);
    expect(((await storedTopPick(user, photoId)) as string) > (before as string)).toBe(true);
  });

  test("a pending photo, a video, a photo in the trash or a missing ID → 404, nothing written", async () => {
    const user = newUserId();
    const pending = (await createPending(repos, newPhoto(user))).photoId;
    const trashed = await readyPhoto(user);
    await repos.photos.trash(user, trashed, new Date());
    const video = newPhoto(user);
    const videoId = (
      await createPending(repos, {
        ...video,
        contentType: "video/mp4",
        originalKey: video.originalKey.replace(/\.jpg$/, ".mp4"),
        mediaType: "video",
      })
    ).photoId;
    await markReady(db, user, videoId, 1000, "2025-06-01T12:00:00.000Z");

    for (const photoId of [pending, trashed, videoId, newId()]) {
      const res = await api(user, "POST", `/photos/${photoId}/top-pick`);
      expect(res.status, photoId).toBe(404);
      expect(await storedTopPick(user, photoId)).toBeUndefined();
    }
    // A missing ID must not leave a stub item behind.
    const stub = newId();
    await api(user, "POST", `/photos/${stub}/top-pick`);
    const out = await db.client.send(
      new GetCommand({ TableName: db.table, Key: { PK: `USER#${user}`, SK: `PHOTO#${stub}` } }),
    );
    expect(out.Item).toBeUndefined();
  });

  test("an invalid ID → 400", async () => {
    const res = await api(newUserId(), "POST", "/photos/not-an-id/top-pick");
    expect(res.status).toBe(400);
  });
});
