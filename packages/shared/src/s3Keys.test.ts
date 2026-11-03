import { describe, expect, test } from "vitest";
import vectors from "../test-vectors/s3-keys.json";
import { MEDIA_CONTENT_TYPES, type MediaType, type OriginalExtension } from "./constants";
import {
  extensionFor,
  mediaTypeOfExtension,
  originalKey,
  parseOriginalKey,
  playbackKey,
  previewKey,
  thumbKey,
  userPrefix,
} from "./s3Keys";

const valid = vectors.valid.map((v) => ({
  ...v,
  ext: v.ext as OriginalExtension,
  mediaType: v.mediaType as MediaType,
}));

describe("key builders", () => {
  test.each(valid)("$original", ({ userId, photoId, ext, original, thumb, preview, playback }) => {
    expect(originalKey(userId, photoId, ext)).toBe(original);
    expect(thumbKey(userId, photoId)).toBe(thumb);
    expect(previewKey(userId, photoId)).toBe(preview);
    expect(playbackKey(userId, photoId)).toBe(playback);
  });

  test("the vectors cover every original extension", () => {
    const covered = new Set(valid.map((v) => v.ext));
    for (const type of MEDIA_CONTENT_TYPES) expect(covered).toContain(extensionFor(type));
  });

  test("reject invalid IDs instead of building a bad key", () => {
    const { userId, photoId } = valid[0]!;
    expect(() => originalKey("../other", photoId, "jpg")).toThrow();
    expect(() => thumbKey(userId, "not-a-ulid")).toThrow();
    expect(() => previewKey(userId.toUpperCase(), photoId)).toThrow();
    expect(() => playbackKey(userId, "../x")).toThrow();
    expect(() => userPrefix("")).toThrow();
  });

  test("userPrefix", () => {
    expect(userPrefix(valid[0]!.userId)).toBe(`users/${valid[0]!.userId}/`);
  });
});

describe("parseOriginalKey", () => {
  test.each(valid)("parses $original", ({ userId, photoId, ext, mediaType, original }) => {
    expect(parseOriginalKey(original)).toEqual({ userId, photoId, ext, mediaType });
  });

  test.each(vectors.invalidOriginalKeys)("ignores %j", (key) => {
    expect(parseOriginalKey(key)).toBeNull();
  });
});

describe("extensionFor", () => {
  test("maps content types to original extensions", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/heic")).toBe("heic");
    expect(extensionFor("image/heif")).toBe("heif");
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("video/mp4")).toBe("mp4");
    expect(extensionFor("video/quicktime")).toBe("mov");
  });

  test("tells videos from photos (FR-VID-1)", () => {
    expect(mediaTypeOfExtension("mp4")).toBe("video");
    expect(mediaTypeOfExtension("mov")).toBe("video");
    expect(mediaTypeOfExtension("jpg")).toBe("photo");
    expect(mediaTypeOfExtension("heic")).toBe("photo");
  });
});
