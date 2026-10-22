import { describe, expect, test } from "vitest";
import { MAX_UPLOAD_BYTES, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "../constants";
import {
  addAlbumPhotosRequestSchema,
  apiErrorSchema,
  createAlbumRequestSchema,
  createShareRequestSchema,
  downloadUrlQuerySchema,
  setUsernameRequestSchema,
  usernameSchema,
  listPhotosQuerySchema,
  photoSchema,
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
    expect(photoSchema.parse(pending)).toEqual(pending);
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
