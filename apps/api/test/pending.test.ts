/** Stale-pending sweep (6.11): abandoned uploads release their quota reservation (5.6b). */
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { newId } from "@photo-app/shared";
import { beforeEach, describe, expect, test } from "vitest";
import { STALE_PENDING_AFTER_MS, sweepStalePending } from "../src/lib/pending";
import { pendingMarkerKey } from "../src/repo/keys";
import { createPending, createTestApi, markReady, newPhoto, newUserId } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let t: TestApi;
// A fresh table per test: the markers of every user share one partition.
beforeEach(async () => {
  t = await createTestApi();
});

const NOW = new Date("2026-06-10T03:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR_MS = 60 * 60 * 1000;

async function pending(userId: string, uploadedAt: string, sizeBytes = 1000) {
  return createPending(t.repos, newPhoto(userId, { uploadedAt, sizeBytes }));
}

async function marker(photo: { userId: string; photoId: string; uploadedAt: string }) {
  const out = await t.db.client.send(
    new GetCommand({
      TableName: t.db.table,
      Key: pendingMarkerKey(photo.uploadedAt, photo.userId, photo.photoId),
    }),
  );
  return out.Item;
}

async function allMarkers() {
  const out = await t.db.client.send(
    new QueryCommand({
      TableName: t.db.table,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "PENDING" },
    }),
  );
  return out.Items ?? [];
}

const sweep = () => sweepStalePending(t.repos, t.storage, NOW);

describe("pending markers (6.11)", () => {
  test("createPending writes one, with a 30-day TTL; a quota refusal writes none", async () => {
    const user = newUserId();
    const photo = await pending(user, ago(HOUR_MS));
    expect(await marker(photo)).toMatchObject({
      PK: "PENDING",
      SK: `UPLOADED#${photo.uploadedAt}#${user}#${photo.photoId}`,
      userId: user,
      photoId: photo.photoId,
      uploadedAt: photo.uploadedAt,
      ttl: Math.ceil(Date.parse(photo.uploadedAt) / 1000) + 30 * 86_400,
    });

    const refused = await t.repos.photos.createPending(newPhoto(user, { sizeBytes: 5000 }), {
      quotaBytes: 1000,
    });
    expect(refused).toBe("quota-exceeded");
    expect(await allMarkers()).toHaveLength(1);
  });

  test("listPendingMarkers: only uploads started before the cut-off", async () => {
    const user = newUserId();
    const old = await pending(user, ago(STALE_PENDING_AFTER_MS + 1));
    await pending(user, ago(STALE_PENDING_AFTER_MS));
    await pending(user, ago(HOUR_MS));
    const before = new Date(NOW.getTime() - STALE_PENDING_AFTER_MS);
    expect(await t.repos.photos.listPendingMarkers(before)).toEqual([
      { userId: user, photoId: old.photoId, uploadedAt: old.uploadedAt },
    ]);
  });
});

describe("sweepStalePending (6.11)", () => {
  test("an upload that never arrived is deleted and its reservation released", async () => {
    const alice = newUserId();
    const bob = newUserId();
    const abandoned = await pending(alice, ago(25 * HOUR_MS), 4000);
    const bobs = await pending(bob, ago(3 * 24 * HOUR_MS), 2000);
    const recent = await pending(alice, ago(2 * HOUR_MS), 500);
    expect(await t.repos.usage.get(alice)).toMatchObject({ bytesReserved: 4500 });

    expect(await sweep()).toEqual({ removed: 2, stuck: 0, cleared: 0, failed: 0, deferred: 0 });

    expect(await t.repos.photos.get(alice, abandoned.photoId)).toBeNull();
    expect(await t.repos.photos.get(bob, bobs.photoId)).toBeNull();
    expect(await t.repos.photos.get(alice, recent.photoId)).not.toBeNull();
    expect(await t.repos.usage.get(alice)).toMatchObject({ bytesReserved: 500 });
    expect(await t.repos.usage.get(bob)).toMatchObject({ bytesReserved: 0 });
    expect(await marker(abandoned)).toBeUndefined();
    expect(await marker(recent)).toBeDefined();
    // Nothing left to do: a second run is a no-op.
    expect(await sweep()).toEqual({ removed: 0, stuck: 0, cleared: 0, failed: 0, deferred: 0 });
  });

  test("an abandoned upload is taken out of its albums too", async () => {
    const user = newUserId();
    const photo = await pending(user, ago(30 * HOUR_MS));
    const album = await t.repos.albums.create({
      ownerId: user,
      albumId: newId(),
      name: "Trip",
      createdAt: NOW.toISOString(),
    });
    await t.repos.albums.addPhotos(user, album.albumId, [photo.photoId], NOW.toISOString());
    expect(await t.repos.albums.hasPhoto(album.albumId, photo.photoId)).toBe(true);

    expect(await sweep()).toMatchObject({ removed: 1 });
    expect(await t.repos.albums.hasPhoto(album.albumId, photo.photoId)).toBe(false);
  });

  test("processed or deleted photos only lose their marker", async () => {
    const user = newUserId();
    const ready = await pending(user, ago(2 * 24 * HOUR_MS), 1000);
    await markReady(t.db, user, ready.photoId, 1000, "2025-06-01T12:00:00.000Z");
    const gone = await pending(user, ago(2 * 24 * HOUR_MS));
    await t.repos.photos.delete(user, gone.photoId);

    expect(await sweep()).toEqual({ removed: 0, stuck: 0, cleared: 2, failed: 0, deferred: 0 });
    expect(await t.repos.photos.get(user, ready.photoId)).toMatchObject({ status: "ready" });
    expect(await t.repos.usage.get(user)).toMatchObject({ photoCount: 1, bytesUsed: 1000 });
    expect(await allMarkers()).toHaveLength(0);
  });

  test("still pending although the original arrived: left alone, marker kept", async () => {
    const user = newUserId();
    const photo = await pending(user, ago(2 * 24 * HOUR_MS));
    t.objects.add(photo.originalKey);

    expect(await sweep()).toEqual({ removed: 0, stuck: 1, cleared: 0, failed: 0, deferred: 0 });
    expect(await t.repos.photos.get(user, photo.photoId)).toMatchObject({ status: "pending" });
    expect(await marker(photo)).toBeDefined();
  });

  test("a failing check is counted and retried next run; the deadline defers the rest", async () => {
    const user = newUserId();
    await pending(user, ago(2 * 24 * HOUR_MS));
    const exists = t.storage.exists;
    t.storage.exists = async () => {
      throw new Error("S3 down");
    };
    expect(await sweep()).toMatchObject({ removed: 0, failed: 1 });
    t.storage.exists = exists;

    expect(await sweepStalePending(t.repos, t.storage, NOW, Date.now() - 1)).toEqual({
      removed: 0,
      stuck: 0,
      cleared: 0,
      failed: 0,
      deferred: 1,
    });
    expect(await sweep()).toMatchObject({ removed: 1 });
  });
});
