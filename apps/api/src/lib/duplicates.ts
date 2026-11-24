import { createHash } from "node:crypto";
import { DUPLICATE_MAX_BITS } from "@photo-app/shared";

/** What finding duplicates reads of a photo (8.37f, FR-GAL-12). */
export interface DuplicateCandidate {
  photoId: string;
  takenAt: string;
  /** ETag of the processed original (12.2b): equal = identical files. */
  originalETag?: string | undefined;
  similarityHash?: string | undefined;
  /** The key of the group the user said aren't duplicates (§8.2). */
  dupDismissed?: string | undefined;
}

/** The 64-bit hash in four 16-bit bands: two hashes ≤ 3 bits apart share at least one. */
const BANDS = 4;
const BAND_HEX = 4;

/**
 * Near-identical images are copies when taken at the same moment (a re-upload, an import of the
 * same photo; one copy may have lost the milliseconds) or far apart (a copy whose date changed,
 * e.g. by a time zone). Taken a moment apart, they are frames of a burst: different shots, which
 * the Gallery stacks (FR-GAL-10), not copies (dev 2026-11-24: copies 0 s or ~8 h apart, burst
 * frames 0.2–5 s apart at 0–3 bits).
 */
export const BURST_WINDOW_MS = 60_000;

function copyTimes(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  const apart = Math.abs(ta - tb);
  if (apart === 0 || apart > BURST_WINDOW_MS) return true;
  // The same second, one without milliseconds: the copy lost its sub-second time.
  return Math.floor(ta / 1000) === Math.floor(tb / 1000) && (ta % 1000 === 0 || tb % 1000 === 0);
}

/** Bits that differ between two 16-hex-character hashes. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (x > 0n) {
    x &= x - 1n;
    bits++;
  }
  return bits;
}

/** §8.2: hex of the SHA-256 of the sorted photo IDs, first 128 bits. Order-independent. */
export function duplicateKey(photoIds: readonly string[]): string {
  return createHash("sha256")
    .update([...photoIds].sort().join(","))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Groups of copies among one user's photos (§9 GET /photos/duplicates): same `originalETag`, or
 * hashes at most `DUPLICATE_MAX_BITS` apart and not taken a moment apart (`copyTimes`), joined
 * transitively (union-find). Candidate pairs come from the hash bands (pigeonhole: 3 differing
 * bits leave a band equal), so no all-pairs comparison. Groups whose photos all carry the group's key were dismissed and are left out; a
 * new copy joining changes the key, so the group shows again. Each group's IDs in input order.
 */
export function findDuplicates(
  photos: readonly DuplicateCandidate[],
): { key: string; photoIds: string[] }[] {
  const parent = photos.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const buckets = new Map<string, number[]>();
  const bucket = (key: string, i: number) => {
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  };
  photos.forEach((photo, i) => {
    if (photo.originalETag) bucket(`etag:${photo.originalETag}`, i);
    const hash = photo.similarityHash;
    if (hash) {
      for (let band = 0; band < BANDS; band++) {
        bucket(`band${band}:${hash.slice(band * BAND_HEX, (band + 1) * BAND_HEX)}`, i);
      }
    }
  });
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    if (key.startsWith("etag:")) {
      for (const i of members.slice(1)) union(members[0]!, i);
      continue;
    }
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const i = members[a]!;
        const j = members[b]!;
        if (find(i) === find(j)) continue;
        if (
          hammingDistance(photos[i]!.similarityHash!, photos[j]!.similarityHash!) <=
            DUPLICATE_MAX_BITS &&
          copyTimes(photos[i]!.takenAt, photos[j]!.takenAt)
        ) {
          union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  photos.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });
  const result: { key: string; photoIds: string[] }[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const photoIds = members.map((i) => photos[i]!.photoId);
    const key = duplicateKey(photoIds);
    if (members.every((i) => photos[i]!.dupDismissed === key)) continue;
    result.push({ key, photoIds });
  }
  return result;
}
