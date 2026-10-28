import type { Api } from "@/api/api";
import { attemptUpload, isAbort } from "./attempt";
import { postToS3, type PostToS3 } from "./s3Post";
import type { UploadItem, UploadStore } from "./store";
import { checkFile } from "./validate";

/** A queue item as the UI sees it: plus the progress of a running upload (0–1). */
export type QueueEntry = UploadItem & { progress: number };

export interface AddResult {
  added: number;
  /** Total size of the added files. */
  addedBytes: number;
  rejected: { fileName: string; reason: string }[];
}

export interface UploadQueue {
  /**
   * Loads the user's queue and starts uploading (if this tab holds the lock). Idempotent per user:
   * a second call returns the first one's promise, so a caller can wait until `add` works.
   */
  start(userId: string): Promise<void>;
  /** Stops uploading in this tab; the queue stays stored and resumes on the next start. */
  stop(): void;
  add(files: Iterable<File>): Promise<AddResult>;
  /** Try a failed upload again. */
  retry(id: string): Promise<void>;
  /** Try every failed upload again (e.g. after freeing up space). */
  retryAll(): Promise<void>;
  /** Cancel and forget an upload (a running one is aborted). */
  remove(id: string): Promise<void>;
  /** Forget the finished uploads. */
  clearFinished(): Promise<void>;
  /** Forget everything, for every user on the device (logout, 8.13). */
  clear(): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Stable between changes (useSyncExternalStore). */
  getSnapshot(): readonly QueueEntry[];
}

export interface UploadQueueDeps {
  api: Pick<Api, "photos">;
  store: UploadStore;
  post?: PostToS3;
  /** After each upload: refresh what shows it (gallery, usage). Awaited, so its tile never blinks. */
  onUploaded?: () => unknown;
  /** Web Locks: one tab uploads, the others show its progress. Absent → this tab always uploads. */
  locks?: LockManager | undefined;
  /** Tells the other tabs about changes. Absent → single tab. */
  createChannel?: (() => BroadcastChannel) | undefined;
  isOnline?: () => boolean;
  /** Whether this tab / app window is on screen: only a visible one takes over (see below). */
  isVisible?: () => boolean;
  /**
   * Background Sync (9.5, Chromium): asks the service worker to upload once this page can't, e.g.
   * the app was closed or Android froze it in the background. Absent → uploads wait for the app.
   */
  registerSync?: (() => unknown) | undefined;
  /** Asks the browser not to evict the queued files (iOS evicts storage of unused sites). */
  requestPersistence?: () => unknown;
  now?: () => number;
  newId?: () => string;
}

/** §12.4: 3 parallel uploads. */
export const CONCURRENCY = 3;
export { RETRY_BASE_MS, RETRY_MAX_MS, retryDelay } from "./attempt";

/** Web Lock held by whoever uploads: one tab, or the service worker (9.5). */
export const LOCK_NAME = "photo-app-uploads";
/** Background Sync tag the tabs register and the service worker handles (9.5). */
export const SYNC_TAG = "photo-app-uploads";
/** BroadcastChannel name for `createChannel` in the app and the service worker. */
export const UPLOAD_CHANNEL_NAME = "photo-app-uploads";
/** Reason shown for a picked file whose bytes can't be read (e.g. a cloud photo not on the device). */
export const UNREADABLE_FILE =
  "This file couldn't be read. If it's stored in the cloud, download it to the device first.";
/** Progress messages to other tabs at most this often. */
const PROGRESS_BROADCAST_MS = 250;
/** How often a waiting tab checks whether the uploading tab is getting anywhere. */
export const TAKEOVER_CHECK_MS = 3000;
/**
 * A visible tab with waiting uploads takes the lock over after this long without upload progress
 * from the tab holding it. A background tab may be frozen, or (Android, with the installed PWA in
 * front) keep running timers while its real work is held back, so "alive" isn't enough: only
 * progress counts.
 */
export const TAKEOVER_AFTER_MS = 10_000;
/** While hidden with uploads waiting, the Background Sync is asked for again this often (9.5). */
export const SYNC_REARM_MS = 60_000;
/**
 * Reading the stored queue is given up after this long; writes are never waited for. On Android
 * an app window frozen in the background mid-transaction stalls the store for minutes in every
 * window (seen over remote debugging, 2026-10-28): uploads stuck at 0 %, picked photos missing,
 * a queue that never started.
 */
export const STORE_READ_TIMEOUT_MS = 2000;

/**
 * Between tabs and the service worker. `working`: the service worker is uploading (its fetch
 * reports no progress), so a tab doesn't take over from it.
 */
export type UploadMessage =
  { type: "changed" } | { type: "progress"; id: string; progress: number } | { type: "working" };

/**
 * The upload queue (§12.4, FR-UP-1/5/6). Files are stored in IndexedDB first, then a worker loop
 * uploads them (attempt.ts) with progress and refreshes the gallery. Temporary failures retry with
 * backoff, on the `online` event and on app start; permanent ones (validation, quota) wait for the
 * user.
 *
 * Only the tab holding the Web Lock uploads; all tabs share the stored queue and hear about
 * changes over a BroadcastChannel. While hidden with uploads waiting, a tab asks for Background
 * Sync, so the service worker uploads after the app is closed or frozen (9.5,
 * pwa/backgroundUploads.ts).
 */
export function createUploadQueue({
  api,
  store,
  post = postToS3,
  onUploaded,
  locks,
  createChannel,
  isOnline = () => navigator.onLine,
  isVisible = () => document.visibilityState === "visible",
  registerSync,
  requestPersistence,
  now = Date.now,
  newId = () => crypto.randomUUID(),
}: UploadQueueDeps): UploadQueue {
  let userId: string | null = null;
  /** Bumped on every start/stop: work from an older session stops touching the state. */
  let session = 0;
  let leader = false;
  let releaseLock: (() => void) | undefined;
  let lockRequest: AbortController | undefined;
  let channel: BroadcastChannel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Not leading: the check whether the leader is getting anywhere. */
  let ticker: ReturnType<typeof setInterval> | undefined;
  /** Hidden: asks for Background Sync again now and then. */
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  /** When the uploading tab last reported progress. */
  let lastProgress = 0;
  /** Since when this tab has seen uploads waiting (null: none); the leader's grace starts then. */
  let waitingSince: number | null = null;
  let persistenceRequested = false;
  let starting: Promise<void> = Promise.resolve();

  const items = new Map<string, UploadItem>();
  /** Items whose latest version isn't stored yet: a reload keeps them as this tab knows them. */
  const unsaved = new Set<string>();
  /** Each item's latest write to IndexedDB (settled either way). */
  const writes = new Map<string, Promise<void>>();
  const progress = new Map<string, number>();
  /** Uploads running in this tab. */
  const active = new Map<string, AbortController>();
  const lastProgressBroadcast = new Map<string, number>();

  const listeners = new Set<() => void>();
  let snapshot: readonly QueueEntry[] = [];

  function emit() {
    snapshot = [...items.values()]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((item) => ({ ...item, progress: progress.get(item.id) ?? 0 }));
    for (const listener of listeners) listener();
  }

  function broadcast(message: UploadMessage) {
    channel?.postMessage(message);
  }

  async function save(item: UploadItem) {
    items.set(item.id, item);
    unsaved.add(item.id);
    emit();
    // Not waited for (see STORE_READ_TIMEOUT_MS). The stored copy only matters if the app closes
    // mid-upload; failing to write it must not stop the upload or a retry (found on Android:
    // "Failed to write blobs (InvalidBlob)").
    const written = store.put(item).then(
      () => {
        if (items.get(item.id) === item) unsaved.delete(item.id);
        broadcast({ type: "changed" });
      },
      (error: unknown) => console.warn("Saving the upload queue failed", error),
    );
    writes.set(item.id, written);
  }

  /** Applies a change to an item still in the queue (it may have been removed meanwhile). */
  async function update(id: string, patch: Partial<UploadItem>) {
    const current = items.get(id);
    if (current) await save({ ...current, ...patch });
  }

  /**
   * Reads the stored queue, keeping this tab's running uploads as it knows them. Returns the IDs
   * read, or null if the store didn't answer in time.
   */
  async function reload(): Promise<Set<string> | null> {
    if (!userId) return null;
    const forSession = session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stored = await Promise.race([
      store.list(userId),
      new Promise<null>((resolve) => (timer = setTimeout(resolve, STORE_READ_TIMEOUT_MS, null))),
    ]).finally(() => clearTimeout(timer));
    // Unreadable for now: carry on with what this tab knows.
    if (!stored || forSession !== session) return null;
    const storedIds = new Set(stored.map((item) => item.id));
    for (const [id, controller] of active) {
      if (!storedIds.has(id) && !unsaved.has(id)) controller.abort();
    }
    const known = new Map(items);
    items.clear();
    for (const item of stored) {
      const mine = active.has(item.id) || unsaved.has(item.id);
      items.set(item.id, (mine && known.get(item.id)) || item);
    }
    for (const id of unsaved) if (!items.has(id) && known.has(id)) items.set(id, known.get(id)!);
    emit();
    // Finished by another tab: refresh what shows it here too (its gallery would stay stale; the
    // uploading tab already did its own before marking the item done).
    const finishedElsewhere = stored.some(
      (item) =>
        item.status === "done" && known.has(item.id) && known.get(item.id)!.status !== "done",
    );
    if (finishedElsewhere) await onUploaded?.();
    return storedIds;
  }

  function onMessage(event: MessageEvent<UploadMessage>) {
    const message = event.data;
    if (message.type === "working") {
      lastProgress = now();
    } else if (message.type === "progress") {
      lastProgress = now();
      if (!items.has(message.id)) return;
      progress.set(message.id, message.progress);
      emit();
    } else {
      void reload().then(pump);
    }
  }

  function onOnline() {
    for (const item of items.values()) if (item.status === "queued") item.retryAt = 0;
    pump();
  }

  /** This tab got the lock: take over what a closed tab left half-done, then start uploading. */
  async function lead(forSession: number) {
    leader = true;
    clearInterval(ticker);
    ticker = undefined;
    const stored = await reload();
    if (forSession !== session) return;
    for (const item of [...items.values()]) {
      // Only what an earlier session left behind, not this session's own work.
      if (!stored?.has(item.id) || active.has(item.id)) continue;
      if (item.status === "uploading") await update(item.id, { status: "queued", retryAt: 0 });
      // Finished in an earlier session: already in the gallery.
      else if (item.status === "done") await forget(item.id);
    }
    pump();
  }

  function pump() {
    clearTimeout(timer);
    if (!leader || !userId || !isOnline()) return;
    const t = now();
    const queued = [...items.values()]
      .filter((item) => item.status === "queued" && !active.has(item.id))
      .sort((a, b) => a.addedAt - b.addedAt);
    for (const item of queued) {
      if (active.size >= CONCURRENCY) break;
      if (item.retryAt <= t) void run(item.id);
    }
    // Wake up for the next backoff that ends.
    const next = Math.min(
      ...[...items.values()]
        .filter((item) => item.status === "queued" && !active.has(item.id) && item.retryAt > t)
        .map((item) => item.retryAt),
    );
    if (Number.isFinite(next)) timer = setTimeout(pump, next - t);
  }

  async function run(id: string) {
    const controller = new AbortController();
    const { signal } = controller;
    active.set(id, controller);
    progress.set(id, 0);
    try {
      await update(id, { status: "uploading", error: null, errorCode: null });
      const item = items.get(id);
      if (!item) return;
      const result = await attemptUpload(
        item,
        { api, post, now },
        {
          signal,
          // The one write waited for, briefly: with the photoId stored before the file goes out,
          // an app closed mid-upload re-signs this photo on its next start instead of
          // uploading a duplicate (5.6a). A stalled store doesn't hold the upload up.
          onPhotoId: async (photoId) => {
            await update(id, { photoId });
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              writes.get(id),
              new Promise((resolve) => (timer = setTimeout(resolve, STORE_READ_TIMEOUT_MS))),
            ]).finally(() => clearTimeout(timer));
          },
          onProgress: (fraction) => {
            if (signal.aborted) return;
            progress.set(id, fraction);
            emit();
            const t = now();
            if (
              fraction === 1 ||
              t - (lastProgressBroadcast.get(id) ?? 0) >= PROGRESS_BROADCAST_MS
            ) {
              lastProgressBroadcast.set(id, t);
              broadcast({ type: "progress", id, progress: fraction });
            }
          },
        },
      );
      if (!result || signal.aborted) return;
      if (result.uploaded) await onUploaded?.();
      await update(id, result.patch);
    } finally {
      if (active.get(id) === controller) active.delete(id);
      progress.delete(id);
      lastProgressBroadcast.delete(id);
      pump();
    }
  }

  async function forget(id: string) {
    active.get(id)?.abort();
    items.delete(id);
    unsaved.delete(id);
    writes.delete(id);
    progress.delete(id);
    emit();
    store.delete(id).then(
      () => broadcast({ type: "changed" }),
      (error: unknown) => console.warn("Removing from the upload queue failed", error),
    );
  }

  /**
   * Asks for the lock; while waiting, a visible tab with uploads to do takes it over from a leader
   * that went quiet. `steal` releases the other tab's lock at once (its uploads stop there and
   * restart here; a re-signed upload that already reached S3 ends as done via 409).
   */
  function requestLock(forSession: number, steal = false) {
    lockRequest?.abort();
    const request = new AbortController();
    lockRequest = request;
    let granted = false;
    // Before the request: a lock granted at once stops the check inside it (lead()). A steal is
    // granted at once; checking meanwhile would steal from itself.
    clearInterval(ticker);
    ticker = undefined;
    if (!steal) {
      waitingSince = null;
      ticker = setInterval(checkTakeover, TAKEOVER_CHECK_MS);
    }
    locks!
      .request(LOCK_NAME, steal ? { steal: true } : { signal: request.signal }, () => {
        if (forSession !== session) return undefined;
        granted = true;
        lockRequest = undefined;
        // Held until stop() (or the tab closes, which hands it to the next tab).
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
          void lead(forSession);
        });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) throw error;
        // Aborted while waiting (stop, or replaced by a takeover request): nothing to undo.
        if (granted && forSession === session) lostLock(forSession);
      });
  }

  function checkTakeover() {
    if (leader || !userId) return;
    const waiting = [...items.values()].some(
      (item) => item.status === "queued" || item.status === "uploading",
    );
    if (!waiting) {
      waitingSince = null;
      return;
    }
    // Counted in the background too, so a window brought back acts at once; only a visible one
    // takes over (a hidden one would just be the next stalled uploader).
    waitingSince ??= now();
    if (!isVisible()) return;
    // Quiet since the work appeared here, or since its last progress, whichever is later.
    if (now() - Math.max(waitingSince, lastProgress) >= TAKEOVER_AFTER_MS)
      requestLock(session, true);
  }

  /** Another tab took the lock over: stop uploading here and wait for it again. */
  function lostLock(forSession: number) {
    leader = false;
    releaseLock = undefined;
    clearTimeout(timer);
    for (const controller of active.values()) controller.abort();
    active.clear();
    progress.clear();
    void reload();
    requestLock(forSession);
  }

  function onVisibilityChange() {
    if (isVisible()) checkTakeover();
  }

  /** Asks for Background Sync if there is anything to upload (registering again is harmless). */
  function armSync() {
    if ([...items.values()].some((item) => item.status === "queued" || item.status === "uploading"))
      void Promise.resolve(registerSync?.()).catch(() => {});
  }

  /**
   * Hidden: the app may be closed or frozen next, so hand the uploads to the service worker. It
   * leaves them to this tab while this tab makes progress; asking again every minute covers a sync
   * that already ran meanwhile (it only runs once per request).
   */
  function onSyncVisibility() {
    clearInterval(syncTimer);
    syncTimer = undefined;
    if (isVisible()) return;
    armSync();
    syncTimer = setInterval(armSync, SYNC_REARM_MS);
  }

  function stop() {
    session++;
    clearTimeout(timer);
    clearInterval(ticker);
    ticker = undefined;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("visibilitychange", onSyncVisibility);
    clearInterval(syncTimer);
    syncTimer = undefined;
    for (const controller of active.values()) controller.abort();
    active.clear();
    progress.clear();
    lockRequest?.abort();
    releaseLock?.();
    lockRequest = releaseLock = undefined;
    leader = false;
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    channel = undefined;
    window.removeEventListener("online", onOnline);
    userId = null;
    items.clear();
    emit();
  }

  async function begin(nextUserId: string) {
    stop();
    userId = nextUserId;
    const forSession = session;
    channel = createChannel?.();
    channel?.addEventListener("message", onMessage);
    window.addEventListener("online", onOnline);
    await reload();
    if (forSession !== session) return;
    if (registerSync) document.addEventListener("visibilitychange", onSyncVisibility);

    if (!locks) return lead(forSession);
    document.addEventListener("visibilitychange", onVisibilityChange);
    requestLock(forSession);
  }

  return {
    start(nextUserId) {
      if (userId === nextUserId) return starting;
      starting = begin(nextUserId);
      return starting;
    },

    stop,

    async add(files) {
      const result: AddResult = { added: 0, addedBytes: 0, rejected: [] };
      if (!userId) return result;
      const owner = userId;
      for (const file of files) {
        const check = checkFile(file);
        if (!check.ok) {
          result.rejected.push({ fileName: file.name || "photo", reason: check.reason });
          continue;
        }
        // Our own copy of the bytes, read now: on Android a picked file is a reference whose read
        // permission can lapse, and every later write of it to IndexedDB then fails (InvalidBlob).
        let copy: Blob;
        try {
          copy = new Blob([await file.arrayBuffer()], { type: file.type });
        } catch {
          result.rejected.push({ fileName: check.fileName, reason: UNREADABLE_FILE });
          continue;
        }
        await save({
          id: newId(),
          userId: owner,
          file: copy,
          fileName: check.fileName,
          contentType: check.contentType,
          sizeBytes: file.size,
          photoId: null,
          status: "queued",
          attempts: 0,
          retryAt: 0,
          error: null,
          errorCode: null,
          addedAt: now(),
        });
        result.added++;
        result.addedBytes += file.size;
      }
      if (result.added && !persistenceRequested) {
        persistenceRequested = true;
        void Promise.resolve(requestPersistence?.()).catch(() => {});
      }
      pump();
      return result;
    },

    async retry(id) {
      await update(id, { status: "queued", attempts: 0, retryAt: 0, error: null, errorCode: null });
      pump();
    },

    async retryAll() {
      for (const item of [...items.values()]) {
        if (item.status !== "failed") continue;
        await update(item.id, {
          status: "queued",
          attempts: 0,
          retryAt: 0,
          error: null,
          errorCode: null,
        });
      }
      pump();
    },

    remove: forget,

    async clearFinished() {
      for (const item of [...items.values()]) if (item.status === "done") await forget(item.id);
    },

    async clear() {
      for (const controller of active.values()) controller.abort();
      items.clear();
      progress.clear();
      emit();
      await store.clear();
      broadcast({ type: "changed" });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,
  };
}
