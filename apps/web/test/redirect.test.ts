import { describe, expect, it } from "vitest";
import { safeRedirect } from "../src/auth/redirect";

describe("safeRedirect", () => {
  it.each(["/gallery", "/albums/01JB2Z3M4N5P6Q7R8S9T0V1W2X", "/gallery?sort=taken-asc#top"])(
    "keeps app path %s",
    (target) => expect(safeRedirect(target)).toBe(target),
  );

  it.each([
    undefined,
    "",
    "gallery",
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example",
    // Control characters URL parsing drops, turning these into //evil.example (12.2c).
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\\evil.example",
    "\t//evil.example",
    "/gallery\\..\\x",
    "/%2e%2e/login",
    "/./login",
    "javascript:alert(1)",
    "/login",
    "/login?redirect=/x",
    "/auth/callback?code=x",
  ])("replaces %s with the gallery", (target) => expect(safeRedirect(target)).toBe("/gallery"));
});
