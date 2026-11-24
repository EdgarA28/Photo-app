import type { Photo } from "@photo-app/shared";

/**
 * Gallery stacks (8.37e, FR-GAL-10/11, §12.3): consecutive photos of the date-sorted list form a
 * stack while each is taken at most `STACK_SECONDS` from the previous one and its
 * `similarityHash` is at most `STACK_BITS` from some photo already in the stack; taken at most
 * `BURST_SECONDS` from the previous one, up to `BURST_BITS`. Tuned on real bursts on dev (8.37d,
 * 2026-11-24): frames of a burst are mostly 0–10 bits apart, different shots and screenshots
 * seconds apart 13+; a frame where the camera moved sideways a little is 15–20 bits from the
 * others (the hash isn't shift-tolerant), but frames that close in time are one burst anyway
 * (user's decision 2026-11-24). Same rules as `services/thumbnails/scripts/stack_dry_run.py`.
 */
export const STACK_SECONDS = 60;
export const STACK_BITS = 10;
export const BURST_SECONDS = 2;
export const BURST_BITS = 20;

/** A run of the list shown as one tile: `top` (the top pick) stands for all of `photos`. */
export interface Stack {
  /** In list order; one photo for a photo that isn't stacked. */
  photos: Photo[];
  top: Photo;
}

/** Bits set in a 32-bit number. */
function popcount(n: number) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hamming distance of two 64-bit hashes as 16 hex characters. */
export function hammingDistance(a: string, b: string): number {
  const half = (hash: string, i: number) => Number.parseInt(hash.slice(i * 8, i * 8 + 8), 16);
  return popcount(half(a, 0) ^ half(b, 0)) + popcount(half(a, 1) ^ half(b, 1));
}

/** Videos, failed photos and photos without a hash (before the backfill) are never stacked. */
const stackable = (photo: Photo) =>
  photo.status === "ready" && photo.mediaType !== "video" && photo.similarityHash !== null;

/**
 * FR-GAL-11: the user's newest choice (`topPickAt`), else the sharpest, else the first.
 */
export function topPick(photos: readonly Photo[]): Photo {
  let best: Photo | undefined;
  for (const photo of photos) {
    if (photo.topPickAt && (!best?.topPickAt || photo.topPickAt > best.topPickAt)) best = photo;
  }
  if (best) return best;
  for (const photo of photos) {
    if (photo.sharpness !== null && (best?.sharpness == null || photo.sharpness > best.sharpness)) {
      best = photo;
    }
  }
  return best ?? photos[0]!;
}

/** Whether `photo` joins the stack ending with `previous` (both stackable). */
function closeEnough(photo: Photo, previous: Photo, stack: readonly Photo[]) {
  const seconds = Math.abs(Date.parse(previous.takenAt) - Date.parse(photo.takenAt)) / 1000;
  if (seconds > STACK_SECONDS) return false;
  const bits = seconds <= BURST_SECONDS ? BURST_BITS : STACK_BITS;
  return stack.some(
    (member) => hammingDistance(member.similarityHash!, photo.similarityHash!) <= bits,
  );
}

/**
 * The list as stacks, in its order (either sort: the time limit is between neighbours, either
 * way). `enabled` false (the Settings switch is off, or a list that isn't the Gallery): one stack
 * per photo, so callers walk stacks either way. Grouped over all loaded pages, so a stack across a
 * page boundary joins when the next page arrives.
 */
export function groupStacks(photos: readonly Photo[], enabled = true): Stack[] {
  const groups: Photo[][] = [];
  let previous: Photo | undefined;
  for (const photo of photos) {
    const current = groups.at(-1);
    const joins =
      enabled &&
      current !== undefined &&
      previous !== undefined &&
      stackable(photo) &&
      stackable(previous) &&
      closeEnough(photo, previous, current);
    if (joins) current.push(photo);
    else groups.push([photo]);
    previous = photo;
  }
  return groups.map((group) => ({
    photos: group,
    top: group.length > 1 ? topPick(group) : group[0]!,
  }));
}

/** Where each photo's stack is in `stacks`. */
export function stackIndex(stacks: readonly Stack[]): Map<string, number> {
  const index = new Map<string, number>();
  stacks.forEach((stack, i) => {
    for (const photo of stack.photos) index.set(photo.photoId, i);
  });
  return index;
}
