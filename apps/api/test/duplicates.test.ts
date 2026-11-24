/** Finding duplicate groups (8.37f, FR-GAL-12, §9): ETags, hash bands, dismissed keys. */
import { describe, expect, test } from "vitest";
import {
  duplicateKey,
  findDuplicates,
  hammingDistance,
  type DuplicateCandidate,
} from "../src/lib/duplicates";

/** 0…0 with these bit positions (0 = lowest) set. */
const hash = (...bits: number[]) =>
  bits
    .reduce((h, bit) => h | (1n << BigInt(bit)), 0n)
    .toString(16)
    .padStart(16, "0");

const T = "2026-10-03T07:18:30.296Z";

/** Taken at the same moment unless said otherwise. */
const c = (photoId: string, rest: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  photoId,
  takenAt: T,
  ...rest,
});

const groups = (photos: DuplicateCandidate[]) => findDuplicates(photos).map((g) => g.photoIds);

describe("hammingDistance", () => {
  test("counts differing bits", () => {
    expect(hammingDistance(hash(), hash())).toBe(0);
    expect(hammingDistance(hash(0, 63), hash())).toBe(2);
    expect(hammingDistance("ffffffffffffffff", hash())).toBe(64);
  });
});

describe("duplicateKey", () => {
  test("the same for any order, 32 hex characters, different for another group", () => {
    expect(duplicateKey(["b", "a"])).toBe(duplicateKey(["a", "b"]));
    expect(duplicateKey(["a", "b"])).toMatch(/^[0-9a-f]{32}$/);
    expect(duplicateKey(["a", "b", "c"])).not.toBe(duplicateKey(["a", "b"]));
  });
});

describe("findDuplicates", () => {
  test("identical files (same ETag) are one group whatever their hashes", () => {
    expect(
      groups([
        c("a", { originalETag: "e1", similarityHash: hash() }),
        c("b", { originalETag: "e2", similarityHash: "ffffffffffffffff" }),
        c("c", { originalETag: "e1" }),
      ]),
    ).toEqual([["a", "c"]]);
  });

  test("hashes at most 3 bits apart are copies; 4 bits are not", () => {
    expect(
      groups([
        c("a", { similarityHash: hash() }),
        c("b", { similarityHash: hash(1, 20, 40) }),
        c("c", { similarityHash: hash(1, 20, 40, 60, 61, 62, 63) }),
      ]),
    ).toEqual([["a", "b"]]);
    expect(
      groups([c("a", { similarityHash: hash() }), c("b", { similarityHash: hash(1, 20, 40, 60) })]),
    ).toEqual([]);
  });

  test("3 bits spread over three bands still share the fourth (pigeonhole)", () => {
    expect(
      groups([c("a", { similarityHash: hash(0, 16, 32) }), c("b", { similarityHash: hash() })]),
    ).toEqual([["a", "b"]]);
  });

  test("copies of copies join one group; photos without a hash or ETag stay out", () => {
    expect(
      groups([
        c("a", { similarityHash: hash() }),
        c("b", { similarityHash: hash(0, 1, 2), originalETag: "e" }),
        c("c", { originalETag: "e" }),
        c("d"),
      ]),
    ).toEqual([["a", "b", "c"]]);
  });

  test("burst frames a moment apart aren't copies; the same moment or far apart are", () => {
    const at = (iso: string) => ({ takenAt: iso, similarityHash: hash() });
    // dev 2026-11-24: frames of a burst 0.26 s apart at 0 bits.
    expect(groups([c("a", at(T)), c("b", at("2026-10-03T07:18:30.037Z"))])).toEqual([]);
    expect(groups([c("a", at(T)), c("b", at("2026-10-03T07:19:30.000Z"))])).toEqual([]);
    // An import 8 h off (time zone), a copy that lost its milliseconds, a copy days later.
    expect(groups([c("a", at(T)), c("b", at("2026-10-03T15:18:30.104Z"))])).toEqual([["a", "b"]]);
    expect(groups([c("a", at(T)), c("b", at("2026-10-03T07:18:30.000Z"))])).toEqual([["a", "b"]]);
    expect(groups([c("a", at(T)), c("b", at("2026-10-05T07:18:31.000Z"))])).toEqual([["a", "b"]]);
    // Identical files whatever the dates.
    expect(
      groups([
        c("a", { originalETag: "e" }),
        c("b", { originalETag: "e", takenAt: "2026-10-03T07:18:31.000Z" }),
      ]),
    ).toEqual([["a", "b"]]);
  });

  test("a dismissed group is left out until its photos change", () => {
    const pair = ["a", "b"];
    const key = duplicateKey(pair);
    const dismissed: DuplicateCandidate[] = [
      c("a", { similarityHash: hash(), dupDismissed: key }),
      c("b", { similarityHash: hash(), dupDismissed: key }),
    ];
    expect(findDuplicates(dismissed)).toEqual([]);
    // Only one of them carries the key (e.g. restored from a copy): shown.
    expect(groups([dismissed[0]!, c("b", { similarityHash: hash() })])).toEqual([pair]);
    // A new copy joins: a new key, shown again.
    const three = groups([...dismissed, c("c", { similarityHash: hash(5) })]);
    expect(three).toEqual([["a", "b", "c"]]);
    expect(findDuplicates([...dismissed, c("c", { similarityHash: hash(5) })])[0]!.key).toBe(
      duplicateKey(["a", "b", "c"]),
    );
  });
});
