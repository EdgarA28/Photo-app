import { describe, expect, test } from "vitest";
import {
  MAX_PARTS_PER_SIGN_REQUEST,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_PARTS,
  MULTIPART_PART_BYTES,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
} from "../constants";
import {
  addAlbumPhotosRequestSchema,
  completeVideoUploadRequestSchema,
  linkedPhotoSchema,
  startVideoUploadRequestSchema,
  startVideoUploadResponseSchema,
  videoPartCount,
  videoPartsRequestSchema,
  videoPartsResponseSchema,
  apiErrorSchema,
  createAlbumRequestSchema,
  createShareRequestSchema,
  downloadUrlQuerySchema,
  meResponseSchema,
  userIdSchema,
  setUsernameRequestSchema,
  usernameSchema,
  listPhotosQuerySchema,
  photoPlaceSchema,
  photoSchema,
  placeIdSchema,
  updateAlbumRequestSchema,
  uploadUrlRequestSchema,
} from "../index";

const PHOTO_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

describe("listPhotosQuerySchema", () => {
  test("applies defaults", () => {
    expect(listPhotosQuerySchema.parse({})).toEqual({
      limit: PAGE_LIMIT_DEFAULT,
      sort: "taken-desc",
    });
  });

  test("coerces limit from query string and enforces bounds", () => {
    expect(listPhotosQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(listPhotosQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listPhotosQuerySchema.safeParse({ limit: String(PAGE_LIMIT_MAX + 1) }).success).toBe(
      false,
    );
    expect(listPhotosQuerySchema.safeParse({ sort: "name" }).success).toBe(false);
  });
});

describe("downloadUrlQuerySchema", () => {
  test("albumId is optional and must be an ID", () => {
    expect(downloadUrlQuerySchema.parse({})).toEqual({});
    const albumId = "01JABCDEFGHJKMNPQRSTVWXYZ0";
    expect(downloadUrlQuerySchema.parse({ albumId })).toEqual({ albumId });
    expect(downloadUrlQuerySchema.safeParse({ albumId: "../x" }).success).toBe(false);
  });
});

describe("uploadUrlRequestSchema", () => {
  const ok = { fileName: "IMG_0001.HEIC", contentType: "image/heic", sizeBytes: 1234 };

  test("accepts supported photos", () => {
    expect(uploadUrlRequestSchema.parse(ok)).toEqual(ok);
  });

  test("rejects unsupported types, oversize and empty names (FR-UP-2, FR-UP-3)", () => {
    expect(uploadUrlRequestSchema.safeParse({ ...ok, contentType: "video/mp4" }).success).toBe(
      false,
    );
    expect(uploadUrlRequestSchema.safeParse({ ...ok, contentType: "image/gif" }).success).toBe(
      false,
    );
    expect(
      uploadUrlRequestSchema.safeParse({ ...ok, sizeBytes: MAX_UPLOAD_BYTES + 1 }).success,
    ).toBe(false);
    expect(uploadUrlRequestSchema.safeParse({ ...ok, sizeBytes: 0 }).success).toBe(false);
    expect(uploadUrlRequestSchema.safeParse({ ...ok, fileName: "   " }).success).toBe(false);
  });

  test("optional photoId for retries must be a photo ID (5.6a)", () => {
    expect(uploadUrlRequestSchema.parse({ ...ok, photoId: PHOTO_ID })).toEqual({
      ...ok,
      photoId: PHOTO_ID,
    });
    expect(uploadUrlRequestSchema.safeParse({ ...ok, photoId: "../x" }).success).toBe(false);
  });
});

describe("photoSchema", () => {
  test("accepts a pending photo without dimensions or URLs", () => {
    const pending = {
      photoId: PHOTO_ID,
      status: "pending",
      fileName: "a.jpg",
      contentType: "image/jpeg",
      sizeBytes: 10,
      width: null,
      height: null,
      takenAt: "2026-10-18T10:00:00Z",
      uploadedAt: "2026-10-18T10:00:00Z",
      thumbUrl: null,
      previewUrl: null,
    };
    // Without `place` (an API from before 13.2), the trash dates (FR-DEL-3) or the owner
    // (FR-SHR-11) they read as null.
    // Without the video fields (FR-VID-*: an API from before videos) it is a photo.
    expect(photoSchema.parse(pending)).toEqual({
      ...pending,
      mediaType: "photo",
      durationMs: null,
      videoCodec: null,
      playable: null,
      place: null,
      trashedAt: null,
      purgeAt: null,
      ownerId: null,
      ownerUsername: null,
    });
  });

  test("a processed video (FR-VID-4, FR-VID-5)", () => {
    const video = photoSchema.parse({
      photoId: PHOTO_ID,
      status: "ready",
      mediaType: "video",
      fileName: "IMG_0001.MOV",
      contentType: "video/quicktime",
      sizeBytes: 123_456_789,
      width: 1920,
      height: 1080,
      durationMs: 12_345,
      videoCodec: "hevc",
      playable: false,
      takenAt: "2026-10-18T10:00:00Z",
      uploadedAt: "2026-10-18T10:00:00Z",
      thumbUrl: "/users/x/thumbs/a.jpg",
      previewUrl: "/users/x/previews/a.jpg",
    });
    expect(video).toMatchObject({ mediaType: "video", durationMs: 12_345, playable: false });
    expect(photoSchema.safeParse({ ...video, mediaType: "audio" }).success).toBe(false);
    expect(photoSchema.safeParse({ ...video, contentType: "video/webm" }).success).toBe(false);
    expect(photoSchema.safeParse({ ...video, durationMs: -1 }).success).toBe(false);
  });

  test("takes a place name, and rejects place IDs in the wrong shape (13.2)", () => {
    const place = { city: "Berlin", region: null, country: "Germany" };
    expect(photoPlaceSchema.parse(place)).toEqual(place);
    for (const ok of ["city:2950159", "region:DE.16", "region:US.NY", "country:DE"]) {
      expect(placeIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["Berlin", "city:", "city:12a", "country:de", "region:DE", "x:DE"]) {
      expect(placeIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("video upload schemas (FR-VID-1, FR-VID-2, §9)", () => {
  const ok = { fileName: "clip.mp4", contentType: "video/mp4", sizeBytes: 1234 };

  test("start accepts MP4 and MOV up to 2 GB", () => {
    expect(startVideoUploadRequestSchema.parse(ok)).toEqual(ok);
    expect(
      startVideoUploadRequestSchema.parse({
        ...ok,
        contentType: "video/quicktime",
        sizeBytes: MAX_VIDEO_BYTES,
      }).sizeBytes,
    ).toBe(MAX_VIDEO_BYTES);
    const bad = [
      { ...ok, sizeBytes: MAX_VIDEO_BYTES + 1 },
      { ...ok, sizeBytes: 0 },
      { ...ok, contentType: "video/webm" },
      { ...ok, contentType: "image/jpeg" },
      { ...ok, fileName: " " },
    ];
    for (const body of bad)
      expect(startVideoUploadRequestSchema.safeParse(body).success).toBe(false);
  });

  test("photo uploads still take photos only", () => {
    const photo = { fileName: "a.jpg", contentType: "video/quicktime", sizeBytes: 10 };
    expect(uploadUrlRequestSchema.safeParse(photo).success).toBe(false);
  });

  test("part count: 16 MB parts, a 2 GB video is 128", () => {
    expect(MULTIPART_PART_BYTES).toBe(16 * 1024 * 1024);
    expect(videoPartCount(1)).toBe(1);
    expect(videoPartCount(MULTIPART_PART_BYTES)).toBe(1);
    expect(videoPartCount(MULTIPART_PART_BYTES + 1)).toBe(2);
    expect(videoPartCount(MAX_VIDEO_BYTES)).toBe(MAX_VIDEO_PARTS);
    expect(MAX_VIDEO_PARTS).toBe(128);
  });

  test("parts request: 1–100 distinct part numbers in range", () => {
    expect(videoPartsRequestSchema.parse({ partNumbers: [1, 2, 3] })).toEqual({
      partNumbers: [1, 2, 3],
    });
    const all = Array.from({ length: MAX_PARTS_PER_SIGN_REQUEST }, (_, i) => i + 1);
    expect(videoPartsRequestSchema.safeParse({ partNumbers: all }).success).toBe(true);
    for (const partNumbers of [
      [],
      [0],
      [MAX_VIDEO_PARTS + 1],
      [1.5],
      [2, 2],
      [...all, MAX_PARTS_PER_SIGN_REQUEST + 1],
    ]) {
      expect(videoPartsRequestSchema.safeParse({ partNumbers }).success).toBe(false);
    }
  });

  test("complete: every part once, with its ETag", () => {
    const parts = [
      { partNumber: 2, etag: '"b"' },
      { partNumber: 1, etag: '"a"' },
    ];
    expect(completeVideoUploadRequestSchema.parse({ parts })).toEqual({ parts });
    for (const bad of [
      [],
      [{ partNumber: 1, etag: "" }],
      [{ partNumber: 1 }],
      [...parts, { partNumber: 1, etag: '"c"' }],
    ]) {
      expect(completeVideoUploadRequestSchema.safeParse({ parts: bad }).success).toBe(false);
    }
  });

  test("responses", () => {
    expect(
      startVideoUploadResponseSchema.parse({
        photoId: PHOTO_ID,
        uploadId: "abc",
        partBytes: MULTIPART_PART_BYTES,
        partCount: 3,
      }).partCount,
    ).toBe(3);
    expect(
      videoPartsResponseSchema.safeParse({
        parts: [{ partNumber: 1, url: "https://bucket.s3.amazonaws.com/k?partNumber=1" }],
        expiresAt: "2026-11-03T10:15:00Z",
      }).success,
    ).toBe(true);
  });
});

describe("linkedPhotoSchema (FR-SHR-8, FR-VID-8)", () => {
  const photo = { photoId: PHOTO_ID, thumbUrl: "t", previewUrl: "p", width: 1, height: 1 };

  test("an entry without video fields is a photo", () => {
    expect(linkedPhotoSchema.parse(photo)).toEqual({
      ...photo,
      mediaType: "photo",
      durationMs: null,
      videoUrl: null,
    });
  });

  test("a video carries its duration and the signed URL of the original", () => {
    const video = { ...photo, mediaType: "video", durationMs: 5000, videoUrl: "https://cdn/v" };
    expect(linkedPhotoSchema.parse(video)).toEqual(video);
  });
});

describe("album schemas", () => {
  test("album names are trimmed and non-empty", () => {
    expect(createAlbumRequestSchema.parse({ name: "  Holidays " })).toEqual({ name: "Holidays" });
    expect(createAlbumRequestSchema.safeParse({ name: "" }).success).toBe(false);
  });

  test("update requires at least one field; cover can be cleared", () => {
    expect(updateAlbumRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAlbumRequestSchema.parse({ coverPhotoId: null })).toEqual({ coverPhotoId: null });
    expect(updateAlbumRequestSchema.parse({ name: "New" })).toEqual({ name: "New" });
    // FR-SHR-11: the members' switch alone is a valid change.
    expect(updateAlbumRequestSchema.parse({ membersCanAdd: true })).toEqual({
      membersCanAdd: true,
    });
    // FR-SHR-12: so is the locations switch, also when turned off.
    expect(updateAlbumRequestSchema.parse({ showLocations: false })).toEqual({
      showLocations: false,
    });
  });

  test("add photos validates IDs", () => {
    expect(addAlbumPhotosRequestSchema.safeParse({ photoIds: [] }).success).toBe(false);
    expect(addAlbumPhotosRequestSchema.safeParse({ photoIds: ["nope"] }).success).toBe(false);
    expect(addAlbumPhotosRequestSchema.parse({ photoIds: [PHOTO_ID] })).toEqual({
      photoIds: [PHOTO_ID],
    });
  });

  test("share email is normalised", () => {
    expect(createShareRequestSchema.parse({ email: " Friend@Example.COM " })).toEqual({
      email: "friend@example.com",
    });
    expect(createShareRequestSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  test("share by username; exactly one of email or username (FR-SHR-5)", () => {
    expect(createShareRequestSchema.parse({ username: "@Ana_R" })).toEqual({ username: "ana_r" });
    expect(createShareRequestSchema.safeParse({}).success).toBe(false);
    expect(createShareRequestSchema.safeParse({ email: "a@b.co", username: "ana_r" }).success).toBe(
      false,
    );
    expect(createShareRequestSchema.safeParse({ username: "a" }).success).toBe(false);
  });
});

describe("usernameSchema (FR-ACC-3)", () => {
  const ok = (input: string) => usernameSchema.safeParse(input);

  test.each([
    ["ana", "ana"],
    ["  @Ana_R ", "ana_r"],
    ["ana.photos", "ana.photos"],
    ["a_b", "a_b"],
    ["007", "007"],
    ["a".repeat(30), "a".repeat(30)],
  ])("accepts %j as %j", (input, expected) => {
    expect(usernameSchema.parse(input)).toBe(expected);
  });

  test.each([
    ["ab", "too short"],
    ["a".repeat(31), "too long"],
    [".ana", "starts with a dot"],
    ["ana_", "ends with an underscore"],
    ["an..a", "consecutive dots"],
    ["ana r", "space"],
    ["ana-r", "hyphen"],
    ["@@ana", "two @"],
    ["аna", "Cyrillic а"],
    ["anä", "non-ASCII"],
    ["admin", "reserved"],
    ["@Support", "reserved after normalising"],
  ])("rejects %j (%s)", (input) => {
    expect(ok(input).success).toBe(false);
  });

  test("set-username request", () => {
    expect(setUsernameRequestSchema.parse({ username: "Ana" })).toEqual({ username: "ana" });
    expect(setUsernameRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("userIdSchema (Cognito sub)", () => {
  test("accepts subs without the RFC 4122 variant bits", () => {
    // A real dev user's sub: `e` starts the 4th group, which z.uuid() rejects.
    const sub = "54589468-8071-707e-e65a-20ae6c5231fc";
    expect(userIdSchema.parse(sub)).toBe(sub);
    const me = {
      userId: sub,
      email: "user@example.com",
      name: null,
      username: null,
      usage: { bytesUsed: 0, photoCount: 0, quotaBytes: 1 },
    };
    expect(meResponseSchema.parse(me)).toEqual(me);
  });

  test("rejects anything that isn't a lowercase UUID", () => {
    for (const bad of [
      "54589468-8071-707E-E65A-20AE6C5231FC",
      "54589468807170 7ee65a20ae6c5231fc",
      "x",
    ]) {
      expect(userIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("apiErrorSchema", () => {
  test("validates the error envelope", () => {
    expect(
      apiErrorSchema.safeParse({ error: { code: "QUOTA_EXCEEDED", message: "Full" } }).success,
    ).toBe(true);
    expect(apiErrorSchema.safeParse({ error: { code: "TEAPOT", message: "" } }).success).toBe(
      false,
    );
  });
});
