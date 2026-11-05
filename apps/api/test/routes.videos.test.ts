/**
 * Video uploads (14.2, §9, FR-VID-1–3): POST /videos/uploads, /videos/{id}/parts and
 * /videos/{id}/complete on DynamoDB Local with the fake photo bucket (helpers: an in-memory model
 * of S3 multipart uploads), plus what videos change elsewhere: cancel / delete, the trash purge,
 * the stale-pending sweep, video URLs for the owner, recipients and public links.
 */
import {
  MAX_VIDEO_BYTES,
  MULTIPART_PART_BYTES,
  SHARED_VIDEO_URL_TTL_SECONDS,
  apiErrorSchema,
  newId,
  photoSchema,
  playbackKey,
  previewKey,
  sharedLinkSchema,
  startVideoUploadResponseSchema,
  thumbKey,
  videoPartsResponseSchema,
} from "@photo-app/shared";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, test } from "vitest";
import { STALE_PENDING_AFTER_MS, sweepStalePending } from "../src/lib/pending";
import { deleteTrashedPhoto } from "../src/lib/trash";
import { partSize } from "../src/routes/videos";
import {
  TEST_DEFAULT_QUOTA,
  createTestApi,
  markReady,
  newUserId,
  nextIso,
  verifySignedUrl,
} from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let t: TestApi;
beforeEach(async () => {
  t = await createTestApi();
});

const errorCode = (body: unknown) => apiErrorSchema.parse(body).error.code;

/** Three parts: two full ones and a small last one. */
const SIZE = 2 * MULTIPART_PART_BYTES + 5;
const start = { fileName: "Beach.MOV", contentType: "video/quicktime", sizeBytes: SIZE };

async function startUpload(user: string, body: object = start) {
  const res = await t.api(user, "POST", "/videos/uploads", body);
  expect(res.status).toBe(201);
  return startVideoUploadResponseSchema.parse(res.body);
}

/** What the web app does: sign every part, PUT each (the fake records it), complete. */
async function uploadAll(user: string, body: { sizeBytes: number } = start) {
  const started = await startUpload(user, body);
  const partNumbers = Array.from({ length: started.partCount }, (_, i) => i + 1);
  const signed = await t.api(user, "POST", `/videos/${started.photoId}/parts`, { partNumbers });
  expect(signed.status).toBe(200);
  const parts = partNumbers.map((n) => ({
    partNumber: n,
    etag: t.uploadPart(started.uploadId, n, partSize(body.sizeBytes, n)),
  }));
  return { ...started, parts };
}

async function complete(user: string, photoId: string, parts: unknown) {
  return t.api(user, "POST", `/videos/${photoId}/complete`, { parts });
}

const originalOf = (user: string, photoId: string) => `users/${user}/originals/${photoId}.mov`;

describe("POST /videos/uploads (FR-VID-1, FR-VID-3)", () => {
  test("creates a pending video, reserves its size and starts a multipart upload", async () => {
    const user = newUserId();
    const { photoId, uploadId, partBytes, partCount } = await startUpload(user);
    expect(partBytes).toBe(MULTIPART_PART_BYTES);
    expect(partCount).toBe(3);

    const key = originalOf(user, photoId);
    expect(t.multipart.get(uploadId)).toMatchObject({ key, contentType: "video/quicktime" });
    expect(await t.repos.photos.get(user, photoId)).toMatchObject({
      status: "pending",
      mediaType: "video",
      contentType: "video/quicktime",
      fileName: "Beach.MOV",
      sizeBytes: SIZE,
      originalKey: key,
      uploadId,
    });
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(SIZE);
    // The stale-pending sweep finds it like any other upload (6.11).
    const markers = await t.repos.photos.listPendingMarkers(new Date(Date.now() + 60_000));
    expect(markers.map((m) => m.photoId)).toContain(photoId);

    // In the gallery straight away, as a video without images (FR-GAL-5).
    const own = photoSchema.parse((await t.api(user, "GET", `/photos/${photoId}`)).body);
    expect(own).toMatchObject({ mediaType: "video", status: "pending", videoUrl: null });
  });

  test("an MP4 gets an .mp4 original; a 2 GB video has 128 parts", async () => {
    const user = newUserId();
    const { photoId, partCount, uploadId } = await startUpload(user, {
      fileName: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: MAX_VIDEO_BYTES,
    });
    expect(partCount).toBe(128);
    expect(t.multipart.get(uploadId)!.key).toBe(`users/${user}/originals/${photoId}.mp4`);
  });

  test.each([
    ["over 2 GB", { sizeBytes: MAX_VIDEO_BYTES + 1 }],
    ["WebM", { contentType: "video/webm" }],
    ["a photo type", { contentType: "image/jpeg" }],
    ["empty", { sizeBytes: 0 }],
  ])("rejects %s (400) and creates nothing", async (_, change) => {
    const user = newUserId();
    const res = await t.api(user, "POST", "/videos/uploads", { ...start, ...change });
    expect(res.status).toBe(400);
    expect(t.multipart.size).toBe(0);
    expect((await t.repos.photos.list(user, { sort: "taken-desc", limit: 10 })).items).toEqual([]);
  });

  test("over the quota: 413 before S3 is asked, nothing more reserved", async () => {
    const user = newUserId();
    const body = { ...start, sizeBytes: Math.floor(TEST_DEFAULT_QUOTA * 0.6) };
    await startUpload(user, body);
    const res = await t.api(user, "POST", "/videos/uploads", body);
    expect(res.status).toBe(413);
    expect(errorCode(res.body)).toBe("QUOTA_EXCEEDED");
    expect(t.multipart.size).toBe(1);
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(body.sizeBytes);
  });

  test("parallel starts can't overshoot the quota; the losers' uploads are aborted", async () => {
    const user = newUserId();
    // Each fits alone, two don't.
    const body = { ...start, sizeBytes: Math.floor(TEST_DEFAULT_QUOTA * 0.6) };
    const results = await Promise.all(
      [1, 2, 3].map(() => t.api(user, "POST", "/videos/uploads", body)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 413, 413]);
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(body.sizeBytes);
    // The quota pre-check may let a request through that the transaction then refuses: that
    // one's multipart upload must not stay behind.
    expect(t.multipart.size).toBe(1);
  });
});

describe("POST /videos/{id}/parts (FR-VID-2)", () => {
  test("signs each requested part, pinned to its size; expiresAt in 15 min", async () => {
    const user = newUserId();
    const { photoId, uploadId } = await startUpload(user);
    const before = Date.now();
    const res = await t.api(user, "POST", `/videos/${photoId}/parts`, { partNumbers: [3, 1] });
    expect(res.status).toBe(200);
    const body = videoPartsResponseSchema.parse(res.body);
    expect(body.parts.map((p) => p.partNumber)).toEqual([3, 1]);
    const ttl = (Date.parse(body.expiresAt) - before) / 1000;
    expect(ttl).toBeGreaterThan(15 * 60 - 5);
    expect(ttl).toBeLessThanOrEqual(15 * 60 + 5);
    const key = originalOf(user, photoId);
    expect(t.signedParts).toEqual([
      { key, uploadId, partNumber: 3, sizeBytes: 5 },
      { key, uploadId, partNumber: 1, sizeBytes: MULTIPART_PART_BYTES },
    ]);
  });

  test("part numbers beyond the video's parts: 400", async () => {
    const user = newUserId();
    const { photoId } = await startUpload(user);
    const res = await t.api(user, "POST", `/videos/${photoId}/parts`, { partNumbers: [4] });
    expect(res.status).toBe(400);
    expect(t.signedParts).toEqual([]);
  });

  test("a photo or a missing ID is 404; a completed video is 409", async () => {
    const user = newUserId();
    const photo = await t.api(user, "POST", "/photos/upload-url", {
      fileName: "a.jpg",
      contentType: "image/jpeg",
      sizeBytes: 10,
    });
    const photoId = (photo.body as { photoId: string }).photoId;
    for (const id of [photoId, newId()]) {
      const res = await t.api(user, "POST", `/videos/${id}/parts`, { partNumbers: [1] });
      expect(res.status).toBe(404);
    }

    const video = await uploadAll(user);
    expect((await complete(user, video.photoId, video.parts)).status).toBe(200);
    const res = await t.api(user, "POST", `/videos/${video.photoId}/parts`, { partNumbers: [1] });
    expect(res.status).toBe(409);
  });
});

describe("POST /videos/{id}/complete (FR-VID-2, §9)", () => {
  test("stores the original; the video stays pending for the video service", async () => {
    const user = newUserId();
    const { photoId, uploadId, parts } = await uploadAll(user);
    // Any order: the storage layer sorts them for S3.
    const res = await complete(user, photoId, [...parts].reverse());
    expect(res).toEqual({ status: 200, body: { photoId } });

    const key = originalOf(user, photoId);
    expect(t.objects.has(key)).toBe(true);
    expect(t.sizes.get(key)).toBe(SIZE);
    expect(t.multipart.has(uploadId)).toBe(false);
    const record = await t.repos.photos.get(user, photoId);
    expect(record).toMatchObject({ status: "pending", mediaType: "video" });
    expect(record!.uploadId).toBeUndefined();
    // Still reserved, not counted: the video service counts it once processed (§10.2).
    expect(await t.repos.usage.get(user)).toMatchObject({ bytesReserved: SIZE, bytesUsed: 0 });

    // Repeating it (the response got lost) is fine.
    expect(await complete(user, photoId, parts)).toEqual({ status: 200, body: { photoId } });
  });

  test("a part missing or a wrong ETag: 400, the upload can still be finished", async () => {
    const user = newUserId();
    const { photoId, parts } = await uploadAll(user);
    const missing = await complete(user, photoId, parts.slice(0, 2));
    expect(missing.status).toBe(400);
    const wrong = parts.map((p, i) => (i === 1 ? { ...p, etag: '"other"' } : p));
    expect((await complete(user, photoId, wrong)).status).toBe(400);
    expect((await complete(user, photoId, parts)).status).toBe(200);
  });

  test("a part number beyond the video's parts: 400", async () => {
    const user = newUserId();
    const { photoId, parts } = await uploadAll(user);
    const res = await complete(user, photoId, [...parts.slice(0, 2), { partNumber: 4, etag: "x" }]);
    expect(res.status).toBe(400);
  });

  test("stored size ≠ declared: object and photo deleted, reservation released, 400", async () => {
    const user = newUserId();
    const { photoId, uploadId, parts } = await uploadAll(user);
    // A last part bigger than signed (S3 would refuse it; this checks the second guard).
    parts[2]!.etag = t.uploadPart(uploadId, 3, 6);
    const res = await complete(user, photoId, parts);
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_ERROR");

    const key = originalOf(user, photoId);
    expect(t.deletes).toContainEqual([key]);
    expect(await t.repos.photos.get(user, photoId)).toBeNull();
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(0);
  });

  test("deleted while completing: the new original is removed, 409", async () => {
    const user = newUserId();
    const { photoId, parts } = await uploadAll(user);
    const completeUpload = t.storage.completeMultipartUpload;
    // A cancel (or the sweep) gets in between S3's complete and markUploaded.
    t.storage.completeMultipartUpload = async (upload, p) => {
      const result = await completeUpload(upload, p);
      await t.repos.photos.delete(user, photoId);
      return result;
    };
    try {
      const res = await complete(user, photoId, parts);
      expect(res.status).toBe(409);
    } finally {
      t.storage.completeMultipartUpload = completeUpload;
    }
    expect(t.deletes).toContainEqual([originalOf(user, photoId)]);
  });

  test("an aborted upload (cancelled, or expired by the lifecycle rule): 409", async () => {
    const user = newUserId();
    const { photoId, uploadId, parts } = await uploadAll(user);
    t.multipart.delete(uploadId);
    const res = await complete(user, photoId, parts);
    expect(res.status).toBe(409);
  });
});

describe("cancel and delete (FR-VID-6)", () => {
  test("DELETE of an uploading video aborts the upload and releases the reservation", async () => {
    const user = newUserId();
    const { photoId, uploadId } = await startUpload(user);
    expect((await t.api(user, "DELETE", `/photos/${photoId}`)).status).toBe(204);

    const key = originalOf(user, photoId);
    expect(t.aborts).toEqual([{ key, uploadId }]);
    expect(t.multipart.has(uploadId)).toBe(false);
    expect(t.deletes).toContainEqual([
      key,
      thumbKey(user, photoId),
      previewKey(user, photoId),
      playbackKey(user, photoId),
    ]);
    expect(await t.repos.photos.get(user, photoId)).toBeNull();
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(0);
  });

  test("a ready video goes to the trash; deleting it for good removes its playback copy too", async () => {
    const user = newUserId();
    const { photoId, parts } = await uploadAll(user);
    await complete(user, photoId, parts);
    await markReady(t.db, user, photoId, SIZE, nextIso());

    expect((await t.api(user, "DELETE", `/photos/${photoId}`)).status).toBe(204);
    expect(t.aborts).toEqual([]);
    const trashed = (await t.repos.photos.get(user, photoId))!;
    expect(trashed.trashedAt).toBeDefined();

    expect(await deleteTrashedPhoto(t.repos, t.storage, trashed)).toBe(true);
    expect(t.deletes.at(-1)).toContain(playbackKey(user, photoId));
    expect(await t.repos.usage.get(user)).toMatchObject({ bytesUsed: 0, bytesReserved: 0 });
  });

  test("the stale-pending sweep removes an upload that never completed and aborts it (6.11)", async () => {
    const user = newUserId();
    const { photoId, uploadId } = await startUpload(user);
    const later = new Date(Date.now() + STALE_PENDING_AFTER_MS + 60_000);
    const result = await sweepStalePending(t.repos, t.storage, later);
    expect(result).toMatchObject({ removed: 1, stuck: 0 });
    expect(t.aborts).toEqual([{ key: originalOf(user, photoId), uploadId }]);
    expect(await t.repos.photos.get(user, photoId)).toBeNull();
    expect(t.deletes).toContainEqual([
      originalOf(user, photoId),
      thumbKey(user, photoId),
      previewKey(user, photoId),
      playbackKey(user, photoId),
    ]);
  });

  test("the sweep: an upload completed right after its check loses its original too", async () => {
    const user = newUserId();
    const { photoId, parts } = await uploadAll(user);
    const exists = t.storage.exists;
    // The check sees nothing; the complete lands before the abort.
    t.storage.exists = async () => {
      await complete(user, photoId, parts);
      return false;
    };
    try {
      const later = new Date(Date.now() + STALE_PENDING_AFTER_MS + 60_000);
      expect(await sweepStalePending(t.repos, t.storage, later)).toMatchObject({ removed: 1 });
    } finally {
      t.storage.exists = exists;
    }
    expect(await t.repos.photos.get(user, photoId)).toBeNull();
    expect(t.deletes.at(-1)).toContain(originalOf(user, photoId));
  });
});

describe("playing a video (FR-VID-5, FR-VID-7, FR-VID-8)", () => {
  async function readyVideo(user: string) {
    const { photoId, parts } = await uploadAll(user);
    await complete(user, photoId, parts);
    await markReady(t.db, user, photoId, SIZE, nextIso());
    return photoId;
  }

  test("own video: the original's stable path (media cookie); photos have none", async () => {
    const user = newUserId();
    const photoId = await readyVideo(user);
    const own = photoSchema.parse((await t.api(user, "GET", `/photos/${photoId}`)).body);
    expect(own).toMatchObject({ mediaType: "video", videoUrl: `/${originalOf(user, photoId)}` });

    const listed = (await t.api(user, "GET", "/photos?mediaType=video")).body as {
      items: unknown[];
    };
    expect(photoSchema.parse(listed.items[0]).videoUrl).toBe(`/${originalOf(user, photoId)}`);
  });

  test("shared video: signed URL for 4 hours in the viewer, none on album pages", async () => {
    const owner = newUserId();
    const friend = newUserId();
    const photoId = await readyVideo(owner);
    const album = await t.repos.albums.create({
      ownerId: owner,
      albumId: newId(),
      name: "Trip",
      createdAt: nextIso(),
    });
    await t.repos.albums.addPhotos(owner, album.albumId, [photoId], nextIso());
    await t.repos.shares.create({
      albumId: album.albumId,
      ownerId: owner,
      userId: friend,
      email: "friend@example.com",
      status: "accepted",
      sharedAt: nextIso(),
    });

    const before = Math.floor(Date.now() / 1000);
    const viewer = photoSchema.parse(
      (await t.api(friend, "GET", `/photos/${photoId}?albumId=${album.albumId}`)).body,
    );
    const expires = verifySignedUrl(viewer.videoUrl!, `/${originalOf(owner, photoId)}`);
    expect(expires - before).toBeGreaterThanOrEqual(SHARED_VIDEO_URL_TTL_SECONDS - 5);
    expect(expires - before).toBeLessThanOrEqual(SHARED_VIDEO_URL_TTL_SECONDS + 5);

    const page = (await t.api(friend, "GET", `/albums/${album.albumId}/photos`)).body as {
      items: unknown[];
    };
    expect(photoSchema.parse(page.items[0]).videoUrl).toBeNull();
  });

  /** What the video service writes once the playback copy is stored (14.9). */
  async function markPlayback(user: string, photoId: string, status: string) {
    await t.db.client.send(
      new UpdateCommand({
        TableName: t.db.table,
        Key: { PK: `USER#${user}`, SK: `PHOTO#${photoId}` },
        UpdateExpression: "SET playbackStatus = :s",
        ExpressionAttributeValues: { ":s": status },
      }),
    );
  }

  test("playback copy (14.9): videoUrl moves to it once ready, the original until then", async () => {
    const user = newUserId();
    const photoId = await readyVideo(user);
    const get = async () =>
      photoSchema.parse((await t.api(user, "GET", `/photos/${photoId}`)).body);
    expect(await get()).toMatchObject({ playbackStatus: null });

    for (const status of ["pending", "failed", "skipped"]) {
      await markPlayback(user, photoId, status);
      expect(await get()).toMatchObject({
        playbackStatus: status,
        videoUrl: `/${originalOf(user, photoId)}`,
      });
    }
    await markPlayback(user, photoId, "ready");
    expect(await get()).toMatchObject({
      playbackStatus: "ready",
      videoUrl: `/${playbackKey(user, photoId)}`,
    });

    // Shared albums and public links sign the copy too.
    const link = (await t.api(user, "POST", "/links", { photoIds: [photoId] })).body as {
      token: string;
    };
    const shared = sharedLinkSchema.parse((await t.api(null, "GET", `/links/${link.token}`)).body);
    verifySignedUrl(shared.photos[0]!.videoUrl!, `/${playbackKey(user, photoId)}`);
  });

  test("photos have no playback status", async () => {
    const user = newUserId();
    const upload = await t.api(user, "POST", "/photos/upload-url", {
      fileName: "a.jpg",
      contentType: "image/jpeg",
      sizeBytes: 1000,
    });
    const { photoId } = upload.body as { photoId: string };
    expect(photoSchema.parse((await t.api(user, "GET", `/photos/${photoId}`)).body)).toMatchObject({
      mediaType: "photo",
      playbackStatus: null,
      videoUrl: null,
    });
  });

  test("public link: the video's original, signed until the link expires", async () => {
    const user = newUserId();
    const photoId = await readyVideo(user);
    const link = (await t.api(user, "POST", "/links", { photoIds: [photoId] })).body as {
      token: string;
      expiresAt: string;
    };
    const shared = sharedLinkSchema.parse((await t.api(null, "GET", `/links/${link.token}`)).body);
    const [video] = shared.photos;
    expect(video).toMatchObject({ mediaType: "video", durationMs: null });
    const expires = verifySignedUrl(video!.videoUrl!, `/${originalOf(user, photoId)}`);
    expect(expires).toBe(Math.floor(Date.parse(link.expiresAt) / 1000));
  });
});

describe("Gallery and Videos are separate lists (FR-VID-11)", () => {
  async function readyVideo(user: string) {
    const { photoId, parts } = await uploadAll(user);
    await complete(user, photoId, parts);
    await markReady(t.db, user, photoId, SIZE, nextIso());
    return photoId;
  }
  const ids = (body: unknown) =>
    (body as { items: { photoId: string }[] }).items.map((p) => p.photoId);

  test("GET /photos lists photos only; ?mediaType=video lists the videos", async () => {
    const user = newUserId();
    const photo = await t.api(user, "POST", "/photos/upload-url", {
      fileName: "a.jpg",
      contentType: "image/jpeg",
      sizeBytes: 10,
    });
    const photoId = (photo.body as { photoId: string }).photoId;
    const videoId = await readyVideo(user);
    const pending = (await startUpload(user)).photoId;

    expect(ids((await t.api(user, "GET", "/photos")).body)).toEqual([photoId]);
    expect(ids((await t.api(user, "GET", "/photos?mediaType=photo")).body)).toEqual([photoId]);
    expect(ids((await t.api(user, "GET", "/photos?mediaType=video")).body).sort()).toEqual(
      [videoId, pending].sort(),
    );
    expect((await t.api(user, "GET", "/photos?mediaType=audio")).status).toBe(400);
  });

  test("a cursor of the Videos list isn't followed in the Gallery", async () => {
    const user = newUserId();
    await readyVideo(user);
    await readyVideo(user);
    const page = (await t.api(user, "GET", "/photos?mediaType=video&limit=1")).body as {
      nextCursor: string;
    };
    const res = await t.api(user, "GET", `/photos?cursor=${encodeURIComponent(page.nextCursor)}`);
    expect(res.status).toBe(400);
  });

  test("a video restored from the trash goes back to the Videos list", async () => {
    const user = newUserId();
    const videoId = await readyVideo(user);
    await t.api(user, "DELETE", `/photos/${videoId}`);
    expect(ids((await t.api(user, "GET", "/photos?mediaType=video")).body)).toEqual([]);
    expect((await t.api(user, "POST", `/trash/${videoId}/restore`)).status).toBe(200);
    expect(ids((await t.api(user, "GET", "/photos?mediaType=video")).body)).toEqual([videoId]);
    expect(ids((await t.api(user, "GET", "/photos")).body)).toEqual([]);
  });
});

describe("partSize", () => {
  test("full parts, then the rest", () => {
    expect(partSize(SIZE, 1)).toBe(MULTIPART_PART_BYTES);
    expect(partSize(SIZE, 2)).toBe(MULTIPART_PART_BYTES);
    expect(partSize(SIZE, 3)).toBe(5);
    expect(partSize(MULTIPART_PART_BYTES, 1)).toBe(MULTIPART_PART_BYTES);
    expect(partSize(MAX_VIDEO_BYTES, 128)).toBe(MULTIPART_PART_BYTES);
  });
});
