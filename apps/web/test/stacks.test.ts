import { photoSchema, type Photo } from "@photo-app/shared";
import { describe, expect, it } from "vitest";
import { groupStacks, hammingDistance, stackIndex, topPick } from "../src/gallery/stacks";
import { testPhoto } from "./fakes";

/** 64 bits, the lowest `bits` set. */
const flip = (bits: number) =>
  (BigInt(2) ** BigInt(bits) - BigInt(1)).toString(16).padStart(16, "0");
const BASE = flip(0);

/** A photo taken `second` seconds into 10:00 on 1 Oct 2026. */
function photo(n: number, second: number, overrides: Record<string, unknown> = {}): Photo {
  return photoSchema.parse(
    testPhoto(n, {
      takenAt: new Date(Date.UTC(2026, 9, 1, 10, 0, second)).toISOString(),
      similarityHash: BASE,
      sharpness: 1,
      ...overrides,
    }),
  );
}

const names = (photos: readonly Photo[], enabled = true) =>
  groupStacks(photos, enabled).map((stack) => stack.photos.map((p) => p.fileName));

describe("hammingDistance", () => {
  it("counts differing bits over all 64", () => {
    expect(hammingDistance(BASE, BASE)).toBe(0);
    expect(hammingDistance(BASE, flip(10))).toBe(10);
    expect(hammingDistance(BASE, "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("8000000000000001", "0000000000000000")).toBe(2);
  });
});

describe("groupStacks (FR-GAL-10, §12.3)", () => {
  it("a burst within 60 s and 10 bits is one stack, newest first or oldest first", () => {
    const burst = [
      photo(0, 20, { similarityHash: flip(3) }),
      photo(1, 10, { similarityHash: flip(10) }),
      photo(2, 0),
    ];
    expect(names(burst)).toEqual([["IMG_0.jpg", "IMG_1.jpg", "IMG_2.jpg"]]);
    expect(names([...burst].reverse())).toEqual([["IMG_2.jpg", "IMG_1.jpg", "IMG_0.jpg"]]);
  });

  it("60 s between neighbours, not from the first photo; 61 s ends the stack", () => {
    expect(names([photo(0, 180), photo(1, 120), photo(2, 60), photo(3, 0)])).toHaveLength(1);
    expect(names([photo(0, 61), photo(1, 0)])).toEqual([["IMG_0.jpg"], ["IMG_1.jpg"]]);
  });

  it("within 2 s of the previous photo, up to 20 bits (a burst where the camera moved a little)", () => {
    const at = (n: number, ms: number, bits: number) =>
      photoSchema.parse(
        testPhoto(n, {
          takenAt: new Date(Date.UTC(2026, 9, 1, 10, 0, 0, ms)).toISOString(),
          similarityHash: flip(bits),
          sharpness: 1,
        }),
      );
    // dev 2026-11-24: 31212 was 0.4 s after 31211 and 18 bits from it.
    expect(names([at(0, 1200, 18), at(1, 800, 0)])).toHaveLength(1);
    expect(names([at(0, 2000, 20), at(1, 0, 0)])).toHaveLength(1);
    expect(names([at(0, 2000, 21), at(1, 0, 0)])).toHaveLength(2);
    // 2.1 s apart: the 10-bit limit again.
    expect(names([at(0, 2100, 11), at(1, 0, 0)])).toHaveLength(2);
    expect(names([at(0, 2100, 10), at(1, 0, 0)])).toHaveLength(1);
  });

  it("joins when close to any photo of the stack (a slow pan drifts away from the first)", () => {
    const pan = [
      photo(0, 20),
      photo(1, 10, { similarityHash: flip(10) }),
      photo(2, 0, { similarityHash: flip(11) }),
    ];
    expect(names(pan)).toHaveLength(1);
    expect(names([pan[0]!, pan[2]!])).toHaveLength(2);
  });

  it("photos without a hash, videos and failed photos stay single", () => {
    const list = [
      photo(0, 30),
      photo(1, 25, { similarityHash: null }),
      photo(2, 20),
      photo(3, 15, { mediaType: "video", contentType: "video/mp4" }),
      photo(4, 10),
      photo(5, 5, { status: "failed", thumbUrl: null, previewUrl: null }),
      photo(6, 0),
    ];
    expect(names(list).every((stack) => stack.length === 1)).toBe(true);
  });

  it("a different photo in between splits the burst: the grid order never changes", () => {
    expect(
      names([photo(0, 20), photo(1, 10, { similarityHash: "ffffffffffffffff" }), photo(2, 0)]),
    ).toHaveLength(3);
  });

  it("switched off: one stack per photo", () => {
    expect(names([photo(0, 1), photo(1, 0)], false)).toEqual([["IMG_0.jpg"], ["IMG_1.jpg"]]);
  });

  it("the top pick stands for the stack; stackIndex finds every member", () => {
    const stacks = groupStacks([
      photo(0, 2, { sharpness: 5 }),
      photo(1, 1, { sharpness: 90 }),
      photo(2, 0),
    ]);
    expect(stacks[0]!.top.fileName).toBe("IMG_1.jpg");
    expect([...stackIndex(stacks).values()]).toEqual([0, 0, 0]);
  });
});

describe("topPick (FR-GAL-11)", () => {
  it("the newest choice, else the sharpest, else the first", () => {
    const sharp = photo(0, 0, { sharpness: 90 });
    const blurry = photo(1, 1, { sharpness: 10 });
    expect(topPick([blurry, sharp])).toBe(sharp);
    const chosen = photo(2, 2, { sharpness: 5, topPickAt: "2026-11-02T10:00:00.000Z" });
    const older = photo(3, 3, { sharpness: 5, topPickAt: "2026-11-01T10:00:00.000Z" });
    expect(topPick([sharp, older, chosen])).toBe(chosen);
    const unrated = [photo(4, 0, { sharpness: null }), photo(5, 1, { sharpness: null })];
    expect(topPick(unrated)).toBe(unrated[0]);
  });
});
