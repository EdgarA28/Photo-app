import {
  extensionFor,
  importClaimId,
  importCopyMessageSchema,
  MAX_FILE_NAME_LENGTH,
  MAX_PHOTOS_PER_IMPORT,
  MAX_UPLOAD_BYTES,
  newId,
  originalKey,
  PHOTO_CONTENT_TYPES,
  type ImportCopyMessage,
  type ImportFailureCode,
  type ImportListMessage,
  importMessageSchema,
  type ImportMessage,
  type PhotoContentType,
} from "@photo-app/shared";
import type { ImportRecord, Repositories } from "../repo";
import { GoogleApiError, type GooglePhotos, type PickedItem } from "./google";
import type { ImportQueue } from "./importQueue";
import { errorFields, log } from "./log";
import type { PhotoStorage } from "./storage";

/**
 * The import worker's two steps (13.5d, §10.1; FR-IMP-2–6, NFR-SEC-10), run by the import queue:
 * `list` turns the user's picks into one `copy` message per photo; `copy` brings one original
 * from Google into S3 the upload way (quota + `pending` item, then the thumbnail Lambda).
 *
 * Errors that retrying can't fix are counted on the import (`failed` with a reason) and the
 * message is done. Anything else throws, and SQS delivers the message again (5 times, then DLQ).
 * Every step is safe to run twice: claims stop a second photo, item markers a second count.
 */
export interface WorkerDeps {
  repos: Repositories;
  storage: PhotoStorage;
  google: Pick<GooglePhotos, "listMediaItems" | "download" | "deleteSession">;
  queue: ImportQueue;
  defaultQuotaBytes: number;
}

/** The part of an SQS record the worker reads. */
export interface SqsRecord {
  messageId: string;
  body: string;
}

/** One SQS record: a valid message runs its step; an unreadable one is dropped. */
export async function handleRecord(deps: WorkerDeps, record: SqsRecord): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(record.body);
  } catch {
    body = undefined;
  }
  const message = importMessageSchema.safeParse(body);
  if (!message.success) {
    // Retrying can't fix it; the body may hold a download URL, so it isn't logged (NFR-SEC-10).
    log("ERROR", "Invalid import message dropped", { messageId: record.messageId });
    return;
  }
  await handleImportMessage(deps, message.data);
}

export async function handleImportMessage(deps: WorkerDeps, message: ImportMessage) {
  if (message.type === "list") await listPicked(deps, message);
  else await copyPhoto(deps, message);
}

const ACTIVE = new Set(["listing", "copying"]);

/** `list` (§10.1): pages the picked items, sends the copies, then `copying` with the totals. */
async function listPicked(deps: WorkerDeps, { userId, importId }: ImportListMessage) {
  const record = await deps.repos.imports.get(userId, importId);
  // Cancelled, expired, or a redelivered message after the list was done: nothing to do.
  if (!record || record.status !== "listing" || !record.accessToken) {
    log("INFO", "Import list skipped", { importId, status: record?.status ?? null });
    return;
  }
  const copies: ImportCopyMessage[] = [];
  let skipped = 0;
  let pageToken: string | undefined;
  try {
    do {
      const page = await deps.google.listMediaItems(
        record.accessToken,
        record.sessionId,
        pageToken,
      );
      for (const item of page.items) {
        const copy = copyMessage(record, item);
        // Videos and other types are skipped (FR-IMP-3, FR-VID-10), as is anything past the
        // limit (the picker already stops at 500, FR-IMP-2).
        if (copy && copies.length < MAX_PHOTOS_PER_IMPORT) copies.push(copy);
        else skipped++;
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (err instanceof GoogleApiError && err.unauthorized) {
      // The token no longer works: nothing can be copied.
      await deps.repos.imports.end(record, "expired");
      log("WARN", "Import expired while listing", { importId });
      return;
    }
    throw err;
  }

  // Copies may start before `copying` is set: they accept `listing` too, and the finish check
  // below covers copies that all ended before it.
  await deps.queue.sendBatch(copies);
  if (!(await deps.repos.imports.setListed(userId, importId, { total: copies.length, skipped }))) {
    log("INFO", "Import ended while listing", { importId });
    return;
  }
  log("INFO", "Import listed", { userId, importId, total: copies.length, skipped });
  await finish(deps, userId, importId);
}

/** A copy message for a picked photo the app takes, or null (skipped). */
function copyMessage(record: ImportRecord, item: PickedItem): ImportCopyMessage | null {
  if (item.type !== "PHOTO") return null;
  const contentType = PHOTO_CONTENT_TYPES.find((type) => type === item.mimeType.toLowerCase());
  if (!contentType) return null;
  const parsed = importCopyMessageSchema.safeParse({
    type: "copy",
    userId: record.userId,
    importId: record.importId,
    mediaItemId: item.mediaItemId,
    baseUrl: item.baseUrl,
    fileName: fileNameOf(item, contentType),
    contentType,
    createTime: item.createTime,
  });
  return parsed.success ? parsed.data : null;
}

/** Google's file name, or one made up from the item ID when it has none (or a too long one). */
function fileNameOf(item: PickedItem, contentType: PhotoContentType): string {
  const name = item.fileName.trim();
  if (name && name.length <= MAX_FILE_NAME_LENGTH) return name;
  return `google-photo-${item.mediaItemId.slice(0, 32)}.${extensionFor(contentType)}`;
}

/** `copy` (§10.1): one original from Google to S3, counted once as done or failed. */
async function copyPhoto(deps: WorkerDeps, message: ImportCopyMessage) {
  const { repos } = deps;
  const { userId, importId, mediaItemId } = message;
  const record = await repos.imports.get(userId, importId);
  if (!record || !ACTIVE.has(record.status) || !record.accessToken) {
    // Cancelled or expired (FR-IMP-5): queued copies stop here; photos already copied stay.
    log("INFO", "Import copy dropped", { importId, status: record?.status ?? null });
    return;
  }
  if (await repos.imports.isCounted(userId, importId, mediaItemId)) {
    await finish(deps, userId, importId);
    return;
  }

  const claimId = importClaimId(importId, mediaItemId);
  const claim = await repos.photos.claim(userId, claimId);
  // An earlier delivery created the photo and its original arrived (or the user deleted it since).
  if (claim && claim.photo?.status !== "pending") return count(deps, message, { kind: "done" });
  // Stored by an earlier delivery that stopped before counting: writing it again could land after
  // the thumbnail Lambda processed it, which marks the photo as replaced (12.2b).
  if (claim?.photo && (await deps.storage.exists(claim.photo.originalKey))) {
    return count(deps, message, { kind: "done" });
  }

  const download = await deps.google.download(
    record.accessToken,
    message.baseUrl,
    MAX_UPLOAD_BYTES,
  );
  if (download.kind !== "ok") {
    const code: ImportFailureCode =
      download.kind === "too-large"
        ? "TOO_LARGE"
        : download.kind === "not-found"
          ? "NOT_FOUND"
          : "EXPIRED";
    // A pending photo of an earlier delivery would wait for an original that never comes.
    if (claim?.photo) {
      await repos.photos.delete(userId, claim.photo.photoId, (p) => p.status === "pending");
    }
    return count(deps, message, { kind: "failed", code });
  }

  let photo = claim?.photo ?? null;
  if (!photo) {
    const usage = await repos.usage.get(userId);
    const photoId = newId();
    const created = await repos.photos.createPending(
      {
        userId,
        photoId,
        fileName: message.fileName,
        contentType: message.contentType,
        // The real size: the bytes are already here, so the quota check is exact (FR-UP-7).
        sizeBytes: download.bytes.byteLength,
        originalKey: originalKey(userId, photoId, extensionFor(message.contentType)),
        uploadedAt: new Date().toISOString(),
      },
      { quotaBytes: usage.quotaBytes ?? deps.defaultQuotaBytes, uploadId: claimId },
    );
    if (created === "quota-exceeded") {
      return count(deps, message, { kind: "failed", code: "QUOTA_EXCEEDED" });
    }
    // A parallel delivery of this message created it; that one copies and counts.
    if (created === "claimed") return;
    photo = created;
  }

  await deps.storage.putOriginal({
    key: photo.originalKey,
    contentType: message.contentType,
    bytes: download.bytes,
    takenAt: new Date(message.createTime).toISOString(),
  });
  await count(deps, message, { kind: "done" });
}

async function count(
  deps: WorkerDeps,
  { userId, importId, mediaItemId }: ImportCopyMessage,
  outcome: { kind: "done" } | { kind: "failed"; code: ImportFailureCode },
) {
  const result = await deps.repos.imports.countItem(userId, importId, mediaItemId, outcome);
  if (outcome.kind === "failed") {
    log("INFO", "Import photo not imported", { importId, reason: outcome.code });
  }
  if (result === "counted") await finish(deps, userId, importId);
}

/** Ends the import once every photo is counted; deletes the Picker session (§10.1 "Finish"). */
async function finish(deps: WorkerDeps, userId: string, importId: string) {
  const ended = await deps.repos.imports.finishIfComplete(userId, importId);
  if (!ended) return;
  log("INFO", "Import done", {
    userId,
    importId,
    total: ended.total,
    done: ended.done,
    failed: ended.failed,
    skipped: ended.skipped,
  });
  if (!ended.accessToken || Date.parse(ended.tokenExpiresAt) <= Date.now()) return;
  try {
    await deps.google.deleteSession(ended.accessToken, ended.sessionId);
  } catch (err) {
    log("WARN", "Picker session not deleted", { importId, ...errorFields(err) });
  }
}
