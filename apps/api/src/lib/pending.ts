import type { PendingMarker, PhotoRecord, Repositories } from "../repo";
import { errorFields, log } from "./log";
import type { PhotoStorage } from "./storage";
import { inBatches } from "./trash";

/**
 * Stale-pending sweep (6.11): uploads that were started but never arrived. Each upload-url
 * request creates a `pending` photo that reserves its size in Usage `bytesReserved` (5.6b); if the
 * file never reaches S3 (tab closed, batch cancelled, connection gone), that reservation would
 * hold quota for good. Run by the daily purge Lambda (`purge.ts`).
 */

/** Pending for longer than this = abandoned. Upload URLs live 15 min; async thumbnail retries end
 * after 6 h, so a photo whose original did arrive is long past processing by then. */
export const STALE_PENDING_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  /** Abandoned uploads deleted (their reservation released). */
  removed: number;
  /** Still pending although the original is in S3: processing failed (see the thumbnail DLQ). */
  stuck: number;
  /** Markers dropped because their photo is no longer pending (ready, failed or deleted). */
  cleared: number;
  failed: number;
  /** Markers left for the next run because time ran out. */
  deferred: number;
}

type Outcome = "removed" | "stuck" | "cleared";

const isAbandoned = (record: PhotoRecord) =>
  record.status === "pending" && record.trashedAt === undefined;

/**
 * Checks every marker older than the cut-off: photo gone or no longer pending → marker dropped;
 * still pending and no original in S3 → photo deleted like `DELETE /photos/{id}` would (album
 * memberships, `bytesReserved`), then the marker; original present → left alone, logged as a
 * warning every day until someone looks (the marker stays). Stops starting new work at
 * `deadline` (epoch ms); what's left waits for the next run.
 */
export async function sweepStalePending(
  repos: Repositories,
  storage: PhotoStorage,
  now: Date,
  deadline = Number.POSITIVE_INFINITY,
): Promise<SweepResult> {
  const markers = await repos.photos.listPendingMarkers(
    new Date(now.getTime() - STALE_PENDING_AFTER_MS),
  );
  const result: SweepResult = { removed: 0, stuck: 0, cleared: 0, failed: 0, deferred: 0 };
  // Chunks, so the deadline is checked between them.
  const CHUNK = 50;
  for (let i = 0; i < markers.length; i += CHUNK) {
    if (Date.now() >= deadline) {
      result.deferred = markers.length - i;
      break;
    }
    const chunk = markers.slice(i, i + CHUNK);
    const outcomes = await inBatches(chunk, (marker) => sweepOne(repos, storage, marker));
    outcomes.forEach((outcome, j) => {
      if (outcome.status === "fulfilled") result[outcome.value]++;
      else {
        result.failed++;
        log("ERROR", "Stale-pending sweep of a photo failed", {
          ...chunk[j],
          ...errorFields(outcome.reason),
        });
      }
    });
  }
  return result;
}

async function sweepOne(
  repos: Repositories,
  storage: PhotoStorage,
  marker: PendingMarker,
): Promise<Outcome> {
  const { userId, photoId } = marker;
  const record = await repos.photos.get(userId, photoId);
  if (record && isAbandoned(record)) {
    if (await storage.exists(record.originalKey)) {
      log("WARN", "Photo still pending a day after its original arrived", {
        userId,
        photoId,
        uploadedAt: marker.uploadedAt,
      });
      return "stuck";
    }
    // Guarded: if the original arrives right now and the thumbnail Lambda finishes first, the
    // status is no longer pending and the delete leaves the photo alone.
    const deleted = await repos.photos.delete(userId, photoId, isAbandoned);
    await repos.photos.deletePendingMarker(marker);
    if (deleted) {
      log("INFO", "Abandoned upload removed", {
        userId,
        photoId,
        uploadedAt: marker.uploadedAt,
        sizeBytes: deleted.sizeBytes,
      });
      return "removed";
    }
    return "cleared";
  }
  await repos.photos.deletePendingMarker(marker);
  return "cleared";
}
