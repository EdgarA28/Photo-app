import { describe, expect, it } from "vitest";
import { errorMessage, ApiRequestError } from "../src/api/errors";
import { formatBytes, formatDuration, videoLabel } from "../src/lib/format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1536, "1.5 KB"],
    [15 * 1024 * 1024, "15 MB"],
    [2 * 1024 ** 3, "2.0 GB"],
  ])("%i → %s", (bytes, text) => expect(formatBytes(bytes)).toBe(text));
});

describe("formatDuration (FR-VID-4)", () => {
  it.each([
    [0, "0:01"],
    [400, "0:01"],
    [5_400, "0:05"],
    [59_600, "1:00"],
    [754_000, "12:34"],
    [3_723_000, "1:02:03"],
  ])("%i ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));

  it("labels a video tile, with or without a known length", () => {
    expect(videoLabel(65_000)).toBe("Video, 1:05");
    expect(videoLabel(null)).toBe("Video");
  });
});

describe("errorMessage", () => {
  it("uses friendly text per code", () => {
    expect(errorMessage(new ApiRequestError("QUOTA_EXCEEDED", "Storage quota exceeded", 413))).toBe(
      "Your storage is full. Delete some photos to upload more.",
    );
  });

  it("keeps the API's explanation for validation errors", () => {
    expect(errorMessage(new ApiRequestError("VALIDATION_ERROR", "name: Too long", 400))).toBe(
      "name: Too long",
    );
  });

  it("falls back to the error message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
});
