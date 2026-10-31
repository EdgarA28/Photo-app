import {
  extensionFor,
  newId,
  originalKey,
  type SaveSharedPhotoResult,
  type SaveSharedPhotosResponse,
} from "@photo-app/shared";
import type { PhotoRecord, Repositories } from "../repo";
import type { PhotoStorage } from "./storage";

/**
 * "Save to my gallery" for photos of an album shared with me (FR-SHR-10): a copy of the original
 * becomes my own photo. It goes the upload way: quota check + `pending` item (`createPending`),
 * then the original is copied in S3 and the thumbnail Lambda processes it like an upload (date
 * taken, size, place). The copy is independent of the owner's photo and counts against my quota.
 *
 * A permanent claim `shared-{photoId}` remembers my copy, so saving the same photo again answers
 * `already-saved` instead of copying it twice. Once my copy is deleted for good, the claim is
 * released and the photo can be saved anew.
 */

/** Photos copied at the same time; their pending items clash on Usage (retried in the repo). */
const CONCURRENCY = 3;

type ItemResult = SaveSharedPhotosResponse["items"][number];

export const saveClaimId = (photoId: string) => `shared-${photoId}`;

/**
 * Saves each source photo (null: not visible to me through the album) and answers in request
 * order. A failure of one photo fails the request; the ones done before stay done, and a retry
 * finds them through their claims.
 */
export async function saveSharedPhotos(
  deps: { repos: Repositories; storage: PhotoStorage; defaultQuotaBytes: number },
  userId: string,
  sources: { photoId: string; photo: PhotoRecord | null }[],
): Promise<ItemResult[]> {
  const usage = await deps.repos.usage.get(userId);
  const quotaBytes = usage.quotaBytes ?? deps.defaultQuotaBytes;
  const results: ItemResult[] = [];
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async ({ photoId, photo }) => {
          if (!photo) return result(photoId, "unavailable");
          // My own photo, e.g. one I added to a collaborative album (FR-SHR-11).
          if (photo.userId === userId) {
            return {
              photoId,
              result: "already-saved" as const,
              savedPhotoId: photo.photoId,
              inTrash: photo.trashedAt !== undefined,
            };
          }
          return saveOne(deps.repos, deps.storage, userId, photo, quotaBytes);
        }),
      )),
    );
  }
  return results;
}

async function saveOne(
  repos: Repositories,
  storage: PhotoStorage,
  userId: string,
  source: PhotoRecord,
  quotaBytes: number,
): Promise<ItemResult> {
  const claimId = saveClaimId(source.photoId);
  // Twice at most: a stale claim (my copy was deleted) is released once, then claimed anew.
  for (let attempt = 0; attempt < 2; attempt++) {
    const claim = await repos.photos.claim(userId, claimId);
    if (claim?.photo) return existing(storage, source, claim.photo);
    if (claim) await repos.photos.releaseClaim(userId, claimId, claim.photoId);

    const photoId = newId();
    const key = originalKey(userId, photoId, extensionFor(source.contentType));
    const created = await repos.photos.createPending(
      {
        userId,
        photoId,
        fileName: source.fileName,
        contentType: source.contentType,
        // The actual size: the thumbnail Lambda stored it when it processed the owner's upload.
        sizeBytes: source.sizeBytes,
        originalKey: key,
        uploadedAt: new Date().toISOString(),
      },
      { quotaBytes, uploadId: claimId, keepClaim: true },
    );
    if (created === "quota-exceeded") return result(source.photoId, "quota-exceeded");
    // A parallel save of the same photo got there first: answer with its copy (next round).
    if (created === "claimed") continue;
    // If the copy fails, the pending item and its claim stay: the next save finds them and copies
    // again (below), so a retry finishes the job without a second photo.
    await storage.copyObject(source.originalKey, key);
    return { ...result(source.photoId, "saved"), savedPhotoId: photoId };
  }
  throw new Error(`Saving photo ${source.photoId} kept clashing with another save`);
}

/** My copy already exists. Still `pending` means an earlier copy didn't finish: copy again. */
async function existing(
  storage: PhotoStorage,
  source: PhotoRecord,
  copy: PhotoRecord,
): Promise<ItemResult> {
  if (copy.status === "pending") {
    await storage.copyObject(source.originalKey, copy.originalKey);
    return { ...result(source.photoId, "saved"), savedPhotoId: copy.photoId };
  }
  return {
    photoId: source.photoId,
    result: "already-saved",
    savedPhotoId: copy.photoId,
    inTrash: copy.trashedAt !== undefined,
  };
}

const result = (photoId: string, outcome: SaveSharedPhotoResult): ItemResult => ({
  photoId,
  result: outcome,
  savedPhotoId: null,
  inTrash: false,
});
