/** Which picked files may enter the queue (FR-UP-2/3, FR-VID-1, 14.5). */
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES } from "@photo-app/shared";
import { describe, expect, it } from "vitest";
import { ACCEPT, checkFile, contentTypeOf, mediaTypeOf } from "../src/upload/validate";

const sized = (name: string, type: string, size: number) => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("checkFile", () => {
  it("takes MP4 and MOV videos up to 2 GB, by type or extension", () => {
    expect(checkFile(sized("clip.mp4", "video/mp4", MAX_VIDEO_BYTES))).toEqual({
      ok: true,
      contentType: "video/mp4",
      fileName: "clip.mp4",
    });
    // Some browsers give MOV no type, or a generic one.
    expect(contentTypeOf({ name: "IMG_0001.MOV", type: "" })).toBe("video/quicktime");
    expect(contentTypeOf({ name: "x.mov", type: "application/octet-stream" })).toBe(
      "video/quicktime",
    );
    expect(mediaTypeOf("video/quicktime")).toBe("video");
    expect(mediaTypeOf("image/heic")).toBe("photo");
  });

  it("says why a file is left out: its own limit for each kind", () => {
    expect(checkFile(sized("clip.mp4", "video/mp4", MAX_VIDEO_BYTES + 1))).toMatchObject({
      ok: false,
      code: "videoSize",
      reason: "Larger than 2.0 GB",
    });
    expect(checkFile(sized("IMG.jpg", "image/jpeg", MAX_UPLOAD_BYTES + 1))).toMatchObject({
      ok: false,
      code: "size",
    });
    expect(checkFile(sized("clip.avi", "video/x-msvideo", 10))).toMatchObject({
      ok: false,
      code: "type",
    });
    expect(checkFile(sized("clip.mp4", "video/mp4", 0))).toMatchObject({ code: "empty" });
  });

  it("names a nameless video 'video'", () => {
    expect(checkFile(sized(" ", "video/mp4", 10))).toMatchObject({ ok: true, fileName: "video" });
  });

  it("the file inputs offer videos too", () => {
    expect(ACCEPT.split(",")).toEqual(
      expect.arrayContaining(["video/mp4", "video/quicktime", ".mp4", ".mov"]),
    );
  });
});
