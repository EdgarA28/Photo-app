import { describe, expect, test } from "vitest";
import vectors from "../test-vectors/s3-keys.json";
import type { OriginalExtension } from "./constants";
import {
  extensionFor,
  originalKey,
  parseOriginalKey,
  previewKey,
  thumbKey,
  userPrefix,
} from "./s3Keys";

const valid = vectors.valid.map((v) => ({ ...v, ext: v.ext as OriginalExtension }));

describe("key builders", () => {
  test.each(valid)("$original", ({ userId, photoId, ext, original, thumb, preview }) => {
    expect(originalKey(userId, photoId, ext)).toBe(original);
    expect(thumbKey(userId, photoId)).toBe(thumb);
    expect(previewKey(userId, photoId)).toBe(preview);
  });

  test("reject invalid IDs instead of building a bad key", () => {
    const { userId, photoId } = valid[0]!;
    expect(() => originalKey("../other", photoId, "jpg")).toThrow();
    expect(() => thumbKey(userId, "not-a-ulid")).toThrow();
    expect(() => previewKey(userId.toUpperCase(), photoId)).toThrow();
    expect(() => userPrefix("")).toThrow();
  });

  test("userPrefix", () => {
    expect(userPrefix(valid[0]!.userId)).toBe(`users/${valid[0]!.userId}/`);
  });
});

describe("parseOriginalKey", () => {
  test.each(valid)("parses $original", ({ userId, photoId, ext, original }) => {
    expect(parseOriginalKey(original)).toEqual({ userId, photoId, ext });
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
  });
});
