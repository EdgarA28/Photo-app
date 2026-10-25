import { describe, expect, it } from "vitest";
import { isThumbnailRequest, onlyImages, thumbnailCacheKey } from "@/pwa/thumbnailCache";

const origin = "https://photos.example";
const match = (path: string, sameOrigin = true) =>
  isThumbnailRequest({ url: new URL(path, origin), sameOrigin });

describe("service worker thumbnail route (9.2, §12.5)", () => {
  it("matches own and shared (signed) thumbnails", () => {
    expect(match("/users/abc-123/thumbs/01J9ZK.jpg")).toBe(true);
    expect(match("/users/abc-123/thumbs/01J9ZK.jpg?Expires=1&Signature=x&Key-Pair-Id=K")).toBe(
      true,
    );
  });

  it("leaves previews, originals, the API and pages to the network", () => {
    expect(match("/users/abc-123/previews/01J9ZK.jpg")).toBe(false);
    expect(match("/users/abc-123/originals/01J9ZK.heic")).toBe(false);
    expect(match("/api/photos")).toBe(false);
    expect(match("/gallery")).toBe(false);
    // Not exactly one segment per part.
    expect(match("/users/thumbs/01J9ZK.jpg")).toBe(false);
    expect(match("/users/abc/thumbs/x/01J9ZK.jpg")).toBe(false);
  });

  it("ignores other origins", () => {
    expect(match("/users/abc-123/thumbs/01J9ZK.jpg", false)).toBe(false);
  });
});

describe("thumbnail cache key", () => {
  it("drops the signature query, so every signed copy shares one entry", async () => {
    const key = (search: string) =>
      thumbnailCacheKey({ request: new Request(`${origin}/users/u/thumbs/p.jpg${search}`) });
    const expected = `${origin}/users/u/thumbs/p.jpg`;
    expect(await key("")).toBe(expected);
    expect(await key("?Expires=1&Signature=a&Key-Pair-Id=K")).toBe(expected);
    expect(await key("?Expires=2&Signature=b&Key-Pair-Id=K")).toBe(expected);
  });
});

describe("thumbnail cache filter", () => {
  const response = (type: string | null) =>
    new Response("x", type ? { headers: { "content-type": type } } : {});

  it("stores images only, never an HTML fallback page", async () => {
    const jpeg = response("image/jpeg");
    expect(await onlyImages({ response: jpeg })).toBe(jpeg);
    expect(await onlyImages({ response: response("text/html") })).toBeNull();
    expect(await onlyImages({ response: response(null) })).toBeNull();
  });
});
