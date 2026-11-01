import { previewKey, thumbKey, type EmptyTrashResult } from "@photo-app/shared";
import type { PhotoRecord, Repositories } from "../repo";
import { errorFields, log } from "./log";
import type { PhotoStorage } from "./storage";

/**
 * Removing trashed photos for good (FR-DEL-3): "Delete forever" and "Empty trash" in the API, and
 * the daily purge Lambda (`purge.ts`) for photos whose 15 days are up.
 */

/** Photos removed at the same time; each one is a few S3 + DynamoDB calls. */
const CONCURRENCY = 5;

/**
 * Deletes one trashed photo like a delete did before the trash (FR-DEL-1): files first, then the
 * item and its Usage (`repos.photos.delete`), so a failure in between leaves a photo that a retry
 * still finds. `guard` decides on the freshly read item; false if it isn't (or no longer) wanted.
 */
export async function deleteTrashedPhoto(
  repos: Repositories,
  storage: PhotoStorage,
  record: PhotoRecord,
  guard: (record: PhotoRecord) => boolean = isTrashed,
): Promise<boolean> {
  if (!guard(record)) return false;
  const { userId, photoId } = record;
  await storage.deleteObjects([
    record.originalKey,
    thumbKey(userId, photoId),
    previewKey(userId, photoId),
  ]);
  return (await repos.photos.delete(userId, photoId, guard)) !== null;
}

export const isTrashed = (record: PhotoRecord) => record.trashedAt !== undefined;

/** Due for the purge at `now` (also re-checked on the item read just before the delete). */
const isExpired = (now: Date) => (record: PhotoRecord) =>
  record.purgeAt !== undefined && record.purgeAt <= now.toISOString();

/**
 * How long one "Empty trash" request keeps deleting before it answers with what is left: the API
 * Lambda stops at 10 s, and a batch already started may still need a few seconds (S3 deletes,
 * conflict retries, 13.4). 534 photos took over 10 s and the request failed (dev, 2026-11-01).
 */
export const EMPTY_TRASH_BUDGET_MS = 5000;

/**
 * "Empty trash", one step: deletes the user's trashed photos, `CONCURRENCY` at a time, until the
 * time budget is used up, and returns how many it deleted and how many are still in the trash
 * (the client asks again until none are left). A failed delete is thrown, as before.
 */
export async function emptyTrash(
  repos: Repositories,
  storage: PhotoStorage,
  userId: string,
  {
    budgetMs = EMPTY_TRASH_BUDGET_MS,
    now = Date.now,
  }: { budgetMs?: number; now?: () => number } = {},
): Promise<EmptyTrashResult> {
  const deadline = now() + budgetMs;
  const trashed = await repos.photos.listTrashed(userId);
  let deleted = 0;
  let done = 0;
  // At least one batch per request, so every request makes progress.
  do {
    const batch = trashed.slice(done, done + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((record) => deleteTrashedPhoto(repos, storage, record)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    deleted += results.filter((result) => result.status === "fulfilled" && result.value).length;
    done += batch.length;
  } while (done < trashed.length && now() < deadline);
  return { deleted, remaining: trashed.length - done };
}

export interface PurgeResult {
  purged: number;
  failed: number;
}

/**
 * The daily purge: every user's trashed photos whose `purgeAt` has passed. A photo that fails is
 * logged and left for the next run; restored ones are skipped by the guard.
 */
export async function purgeExpired(
  repos: Repositories,
  storage: PhotoStorage,
  now: Date,
): Promise<PurgeResult> {
  const expired = await repos.photos.listExpired(now);
  const guard = isExpired(now);
  const results = await inBatches(expired, async ({ userId, photoId }) => {
    const record = await repos.photos.get(userId, photoId);
    return record ? deleteTrashedPhoto(repos, storage, record, guard) : false;
  });
  let purged = 0;
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (result.value) purged++;
    } else {
      failed++;
      log("ERROR", "Purge of a trashed photo failed", {
        ...expired[i],
        ...errorFields(result.reason),
      });
    }
  });
  return { purged, failed };
}

/** Runs `fn` over `items`, `CONCURRENCY` at a time; every result, failures included. */
export async function inBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    results.push(...(await Promise.allSettled(items.slice(i, i + CONCURRENCY).map(fn))));
  }
  return results;
}
