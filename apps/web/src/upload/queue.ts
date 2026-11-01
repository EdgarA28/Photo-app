import type { Api } from "@/api/api";
import { attemptUpload, isAbort } from "./attempt";
import { postToS3, type PostToS3 } from "./s3Post";
import type { UploadItem, UploadStore } from "./store";
import {
  BATCH_SAVE_MS,
  fileKey,
  INTERRUPTED_AFTER_MS,
  type BatchRecord,
  type BatchStore,
  type InterruptedBatch,
} from "./batches";
import { checkFile, type SkipCode } from "./validate";

/** A picked file that wasn't added, with the reason shown and its group (13.1b). */
export interface SkippedFile {
  fileName: string;
  reason: string;
  code: SkipCode;
}

/** A queue item as the UI sees it: plus the progress of a running upload (0–1). */
export type QueueEntry = UploadItem & { progress: number };

export interface AddResult {
  added: number;
  /** Total size of the added files. */
  addedBytes: number;
  rejected: SkippedFile[];
  /** Files of an interrupted batch picked again that were uploaded already, skipped (13.1f). */
  alreadyUploaded?: number;
}

export interface AddOptions {
  /** Picked as a folder (13.1a): always a large batch, whatever its size. */
  folder?: boolean;
  /** The folder's name, to say which batch was interrupted (13.1f). */
  label?: string | null;
}

export interface UploadQueue {
  /**
   * Loads the user's queue and starts uploading (if this tab holds the lock). Idempotent per user:
   * a second call returns the first one's promise, so a caller can wait until `add` works.
   */
  start(userId: string): Promise<void>;
  /** Stops uploading in this tab; the queue stays stored and resumes on the next start. */
  stop(): void;
  add(files: Iterable<File>, options?: AddOptions): Promise<AddResult>;
  /** Try a failed upload again. */
  retry(id: string): Promise<void>;
  /** Try every failed upload again (e.g. after freeing up space). */
  retryAll(): Promise<void>;
  /** Cancel and forget an upload (a running one is aborted). */
  remove(id: string): Promise<void>;
  /** Forget everything, for every user on the device (logout, 8.13). */
  clear(): Promise<void>;
  /** Pause every waiting or running upload (13.1d); running ones stop and start over on resume. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Cancel and forget every upload that isn't finished (13.1d). */
  cancelAll(): Promise<void>;
  /** Photos of a large batch still to upload in other tabs of this app (13.1d). */
  getOtherTabsRemaining(): number;
  /** Large batches no tab is running any more, with what is left of them (13.1f). */
  interruptedBatches(): Promise<InterruptedBatch[]>;
  /** Forget an interrupted batch ("Dismiss"). */
  dismissBatch(batchId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Stable between changes (useSyncExternalStore). */
  getSnapshot(): readonly QueueEntry[];
}

export interface UploadQueueDeps {
  api: Pick<Api, "photos">;
  store: UploadStore;
  post?: PostToS3;
  /**
   * After uploads: refresh what shows them (gallery, usage). Coalesced to at most one call per
   * `refreshEveryMs` (13.1-0); an upload stays on screen as uploading until the refresh after it
   * is done, so its tile never blinks, without holding its upload slot meanwhile.
   */
  onUploaded?: () => unknown;
  /** Minimum time between two `onUploaded` calls; the first one runs at once. */
  refreshEveryMs?: number;
  /** Runs the change notification for the UI: once per animation frame (13.1-0). */
  scheduleFrame?: (callback: () => void) => unknown;
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
  /** Phones copy every pick (Android can revoke access to picked files), up to `PHONE_PICK_BYTES`. */
  isPhone?: () => boolean;
  /** Picks above this total are large batches (13.1c); default `LARGE_BATCH_BYTES`. */
  largeBatchBytes?: number;
  /** Remembers large batches so they can be continued (13.1f). Absent → not remembered. */
  batches?: BatchStore | undefined;
  now?: () => number;
  newId?: () => string;
}

/** §12.4: 3 parallel uploads. */
export const CONCURRENCY = 3;
/**
 * A pick above this total (or a folder) is a large batch (13.1c, user 2026-11-01): its files are
 * read at upload time instead of copied, and it is kept only in the tab that picked it.
 */
export const LARGE_BATCH_BYTES = 500 * 1024 * 1024;
/** Phones copy every pick, so one pick is limited to this (13.1c, user 2026-11-01). */
export const PHONE_PICK_BYTES = 1024 * 1024 * 1024;
/** Reason for files left out of a phone pick above `PHONE_PICK_BYTES`. */
export const PHONE_LIMIT =
  "Not added: up to 1 GB per pick on a phone. Add the rest once these are uploaded, or use a computer.";

/** Phone or tablet: Client Hints where available, else the user agent. */
export const looksLikePhone = () =>
  (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile ??
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** At most one gallery + usage refresh this often while uploads finish (13.1-0). */
export const REFRESH_EVERY_MS = 5000;

const nextFrame = (callback: () => void) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : setTimeout(callback, 16);
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

/** Stored and still to upload: what another tab or the service worker could take over. */
const isStoredWork = (item: UploadItem) =>
  !item.memoryOnly && !item.paused && (item.status === "queued" || item.status === "uploading");

/** How often a tab with a large batch tells the others how far it is (13.1d). */
export const BATCH_HEARTBEAT_MS = 2000;
/** Another tab's batch count is forgotten after this long without news (the tab was closed). */
export const BATCH_STALE_MS = 3 * BATCH_HEARTBEAT_MS;
/** "changed" messages to the other tabs are gathered this long: a bulk change sends one. */
export const CHANGED_BROADCAST_MS = 50;

/**
 * Between tabs and the service worker. `working`: the service worker is uploading (its fetch
 * reports no progress), so a tab doesn't take over from it.
 */
export type UploadMessage =
  | { type: "changed" }
  | { type: "progress"; id: string; progress: number }
  | { type: "working" }
  /** A tab's large batch (13.1d): how many of its photos are still to upload. */
  | { type: "batch"; tab: string; remaining: number };

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
  refreshEveryMs = REFRESH_EVERY_MS,
  scheduleFrame = nextFrame,
  locks,
  createChannel,
  isOnline = () => navigator.onLine,
  isVisible = () => document.visibilityState === "visible",
  registerSync,
  requestPersistence,
  isPhone = looksLikePhone,
  largeBatchBytes = LARGE_BATCH_BYTES,
  batches,
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
  /** This tab, for its large-batch messages (13.1d). */
  const tabId = crypto.randomUUID();
  /** Other tabs' large batches: photos left and when last heard. */
  const otherTabs = new Map<string, { remaining: number; at: number }>();
  let otherTabsRemaining = 0;
  let batchTimer: ReturnType<typeof setInterval> | undefined;
  let lastBatchSent = 0;
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  /** This tab's large batches being uploaded, as remembered (13.1f). */
  const liveBatches = new Map<string, BatchRecord>();
  let batchSaveTimer: ReturnType<typeof setInterval> | undefined;

  const listeners = new Set<() => void>();
  let snapshot: readonly QueueEntry[] = [];
  /** The snapshot is out of date; it is rebuilt when next read. */
  let dirty = false;
  let notifyScheduled = false;
  /** Entries kept while their item and progress are unchanged, so unchanged rows don't render. */
  const entries = new WeakMap<UploadItem, QueueEntry>();

  /**
   * Something changed. The snapshot is rebuilt lazily and the UI told at most once per frame:
   * with thousands of files, progress events would otherwise re-sort and re-render everything
   * many times a second (13.1-0).
   */
  function emit() {
    dirty = true;
    if (notifyScheduled) return;
    notifyScheduled = true;
    scheduleFrame(() => {
      notifyScheduled = false;
      for (const listener of listeners) listener();
    });
  }

  function getSnapshot(): readonly QueueEntry[] {
    if (!dirty) return snapshot;
    dirty = false;
    snapshot = [...items.values()]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((item) => {
        const value = progress.get(item.id) ?? 0;
        const known = entries.get(item);
        if (known?.progress === value) return known;
        const entry = { ...item, progress: value };
        entries.set(item, entry);
        return entry;
      });
    return snapshot;
  }

  /** When `onUploaded` last started, and the next call if one is waiting. */
  let lastRefresh = -Infinity;
  let nextRefresh: Promise<void> | undefined;

  /**
   * Refreshes the gallery and usage after uploads: at once if the last refresh is long enough
   * ago, else once the interval has passed, for everything that finished meanwhile. Resolves once
   * a refresh that started after this call has finished (13.1-0).
   */
  function refresh(): Promise<void> {
    if (!onUploaded) return Promise.resolve();
    if (nextRefresh) return nextRefresh;
    let resolve!: () => void;
    const pending = new Promise<void>((r) => (resolve = r));
    nextRefresh = pending;
    const go = () => {
      nextRefresh = undefined;
      lastRefresh = now();
      Promise.resolve()
        .then(onUploaded)
        .catch((error: unknown) => console.warn("Refreshing after uploads failed", error))
        .finally(resolve);
    };
    const wait = lastRefresh + refreshEveryMs - now();
    if (wait > 0) setTimeout(go, wait);
    else go();
    return pending;
  }

  function broadcast(message: UploadMessage) {
    channel?.postMessage(message);
  }

  /**
   * Saves this tab's large batches (13.1f): what is uploaded so far and a sign of life. A batch
   * with nothing left to do is forgotten; one whose tab closes stops being saved and shows as
   * interrupted a little later.
   */
  async function saveBatches() {
    if (!batches) return;
    const unfinished = new Map<string, number>();
    for (const item of items.values()) {
      if (item.batchId && item.status !== "done") {
        unfinished.set(item.batchId, (unfinished.get(item.batchId) ?? 0) + 1);
      }
    }
    for (const [batchId, record] of [...liveBatches]) {
      try {
        if (!unfinished.get(batchId)) {
          liveBatches.delete(batchId);
          await batches.delete(batchId);
        } else {
          record.heartbeatAt = now();
          await batches.put(record);
        }
      } catch (error) {
        console.warn("Saving the upload batch failed", error);
      }
    }
  }

  /** Remembered batches of this user that no tab runs any more. */
  async function interruptedRecords(): Promise<BatchRecord[]> {
    if (!batches || !userId) return [];
    const quietSince = now() - INTERRUPTED_AFTER_MS;
    return (await batches.list(userId)).filter(
      (record) => !liveBatches.has(record.batchId) && record.heartbeatAt < quietSince,
    );
  }

  /** Tells the other tabs the stored queue changed, once for a burst of writes (pause, cancel). */
  function announceChanged() {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      broadcast({ type: "changed" });
    }, CHANGED_BROADCAST_MS);
  }

  /**
   * Every few seconds: tells the other tabs how much of this tab's large batch is left (they can't
   * see it, 13.1c), and forgets other tabs' batches that went quiet (closed).
   */
  function batchHeartbeat() {
    let remaining = 0;
    for (const item of items.values()) {
      if (item.memoryOnly && (item.status === "queued" || item.status === "uploading")) remaining++;
    }
    if (remaining || lastBatchSent) broadcast({ type: "batch", tab: tabId, remaining });
    lastBatchSent = remaining;
    const t = now();
    for (const [tab, batch] of otherTabs) if (t - batch.at > BATCH_STALE_MS) otherTabs.delete(tab);
    updateOtherTabs();
  }

  function updateOtherTabs() {
    let total = 0;
    for (const batch of otherTabs.values()) total += batch.remaining;
    if (total === otherTabsRemaining) return;
    otherTabsRemaining = total;
    emit();
  }

  async function save(item: UploadItem) {
    items.set(item.id, item);
    emit();
    // A large batch lives in this tab only (13.1c).
    if (item.memoryOnly) return;
    unsaved.add(item.id);
    // Not waited for (see STORE_READ_TIMEOUT_MS). The stored copy only matters if the app closes
    // mid-upload; failing to write it must not stop the upload or a retry (found on Android:
    // "Failed to write blobs (InvalidBlob)").
    const written = store.put(item).then(
      () => {
        if (items.get(item.id) === item) unsaved.delete(item.id);
        announceChanged();
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
      if (!storedIds.has(id) && !unsaved.has(id) && !items.get(id)?.memoryOnly) controller.abort();
    }
    const known = new Map(items);
    items.clear();
    for (const item of stored) {
      const mine = active.has(item.id) || unsaved.has(item.id);
      items.set(item.id, (mine && known.get(item.id)) || item);
    }
    for (const id of unsaved) if (!items.has(id) && known.has(id)) items.set(id, known.get(id)!);
    // This tab's large batch isn't in the store: kept as it is (13.1c).
    for (const [id, item] of known) if (item.memoryOnly) items.set(id, item);
    emit();
    // Finished by another tab: refresh what shows it here too (its gallery would stay stale; the
    // uploading tab already did its own before marking the item done).
    const finishedElsewhere = stored.some(
      (item) =>
        item.status === "done" && known.has(item.id) && known.get(item.id)!.status !== "done",
    );
    if (finishedElsewhere) void refresh();
    return storedIds;
  }

  function onMessage(event: MessageEvent<UploadMessage>) {
    const message = event.data;
    if (message.type === "batch") {
      // Its own uploads also count as progress: no takeover from a tab busy with its batch.
      if (message.remaining)
        otherTabs.set(message.tab, { remaining: message.remaining, at: now() });
      else otherTabs.delete(message.tab);
      updateOtherTabs();
    } else if (message.type === "working") {
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

  /**
   * Starts queued uploads up to `CONCURRENCY`, oldest first (the items are kept in the order
   * added), and wakes up for the next backoff that ends. One pass, stopping once all slots are
   * busy (a finishing upload pumps again): called per added file, so no sorting (13.1-0).
   */
  function pump() {
    clearTimeout(timer);
    if (!userId || !isOnline()) return;
    const t = now();
    let next = Infinity;
    for (const item of items.values()) {
      if (active.size >= CONCURRENCY) return;
      if (item.status !== "queued" || item.paused || active.has(item.id)) continue;
      // Stored items only in the tab holding the lock; this tab's large batch always here (13.1c).
      if (!leader && !item.memoryOnly) continue;
      if (item.retryAt <= t) void run(item.id);
      else next = Math.min(next, item.retryAt);
    }
    if (Number.isFinite(next)) timer = setTimeout(pump, next - t);
  }

  async function run(id: string) {
    const controller = new AbortController();
    const { signal } = controller;
    active.set(id, controller);
    progress.set(id, 0);
    /** Uploaded: the item's final state, applied once the gallery shows the photo. */
    let finished: Partial<UploadItem> | undefined;
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
      if (result.uploaded) finished = result.patch;
      else {
        await update(id, result.patch);
        if (result.patch.errorCode === "QUOTA_EXCEEDED") await stopForSpace(result.patch.error);
      }
    } finally {
      if (active.get(id) === controller) active.delete(id);
      if (finished) progress.set(id, 1);
      else progress.delete(id);
      lastProgressBroadcast.delete(id);
      emit();
      // The slot is free for the next file while the gallery refresh below is waited for.
      pump();
    }
    if (!finished) return;
    await refresh();
    progress.delete(id);
    const item = items.get(id);
    await update(id, finished);
    // Remembered as uploaded, so a re-pick after an interruption skips it (13.1f).
    if (item?.batchId && item.sourceKey) liveBatches.get(item.batchId)?.done.push(item.sourceKey);
  }

  /**
   * Storage is full (FR-UP-7, 13.1e): every file still waiting would be refused too, so they all
   * stop here as "storage full" at once, without asking the server for each (a big folder would
   * otherwise send thousands of requests that fail). Uploads already running finish or fail on
   * their own; "Retry all" (8.14) sends the rest again once space is freed.
   */
  async function stopForSpace(error: string | null | undefined) {
    for (const item of [...items.values()]) {
      if (item.status !== "queued" || active.has(item.id)) continue;
      await update(item.id, {
        status: "failed",
        error: error ?? null,
        errorCode: "QUOTA_EXCEEDED",
        retryAt: 0,
      });
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
      () => announceChanged(),
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
    // Only stored work needs the lock; this tab uploads its large batch anyway (13.1c).
    const waiting = [...items.values()].some(isStoredWork);
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
    // The new holder restarts the stored uploads; this tab's large batch carries on here (13.1c).
    for (const [id, controller] of active) {
      if (items.get(id)?.memoryOnly) continue;
      controller.abort();
      active.delete(id);
      progress.delete(id);
    }
    void reload().then(pump);
    requestLock(forSession);
  }

  function onVisibilityChange() {
    if (isVisible()) checkTakeover();
  }

  /** Asks for Background Sync if there is anything to upload (registering again is harmless). */
  function armSync() {
    // The service worker can only upload what is stored, not a large batch (13.1c).
    if ([...items.values()].some(isStoredWork))
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
    clearInterval(batchTimer);
    batchTimer = undefined;
    clearInterval(batchSaveTimer);
    batchSaveTimer = undefined;
    // Not saved any more: shows as interrupted on the next start (13.1f).
    liveBatches.clear();
    otherTabs.clear();
    otherTabsRemaining = 0;
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
    if (channel) batchTimer = setInterval(batchHeartbeat, BATCH_HEARTBEAT_MS);
    if (batches) batchSaveTimer = setInterval(() => void saveBatches(), BATCH_SAVE_MS);
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

    async add(files, options = {}) {
      const result: AddResult = { added: 0, addedBytes: 0, rejected: [] };
      if (!userId) return result;
      const owner = userId;
      const accepted: { file: File; fileName: string; contentType: UploadItem["contentType"] }[] =
        [];
      for (const file of files) {
        const check = checkFile(file);
        if (check.ok) accepted.push({ file, ...check });
        else {
          result.rejected.push({
            fileName: file.name || "photo",
            reason: check.reason,
            code: check.code,
          });
        }
      }
      const phone = isPhone();
      const total = accepted.reduce((sum, { file }) => sum + file.size, 0);
      // 13.1c: a folder or a big pick on a computer is read from the disk at upload time and kept
      // in this tab only; phones copy every pick (below), so one pick is capped there.
      const large = !phone && (options.folder === true || total > largeBatchBytes);
      let picked = 0;

      // 13.1f: a large batch is remembered; picked again after an interruption, the files already
      // uploaded are skipped and the same batch goes on.
      let batch: BatchRecord | undefined;
      let todo = accepted;
      if (large && batches) {
        let interrupted: BatchRecord[] = [];
        try {
          interrupted = await interruptedRecords();
        } catch (error) {
          console.warn("Reading the remembered upload batches failed", error);
        }
        const keys = accepted.map(({ file }) => fileKey(file));
        const pickedKeys = new Set(keys);
        const overlap = (record: BatchRecord) =>
          record.keys.filter((key) => pickedKeys.has(key)).length;
        batch = interrupted
          .filter((record) => overlap(record) > 0)
          .sort((a, b) => overlap(b) - overlap(a))[0];
        const uploaded = new Set(interrupted.flatMap((record) => record.done));
        todo = accepted.filter(({ file }) => !uploaded.has(fileKey(file)));
        if (accepted.length > todo.length) result.alreadyUploaded = accepted.length - todo.length;
        batch = batch
          ? { ...batch, keys: [...new Set([...batch.keys, ...keys])] }
          : {
              batchId: crypto.randomUUID(),
              userId: owner,
              label: options.label ?? null,
              createdAt: now(),
              heartbeatAt: now(),
              keys,
              done: [],
            };
        batch.heartbeatAt = now();
        if (todo.length) {
          liveBatches.set(batch.batchId, batch);
          await batches.put(batch).catch((error: unknown) => {
            console.warn("Saving the upload batch failed", error);
          });
        }
      }

      for (const { file, fileName, contentType } of todo) {
        if (phone && picked + file.size > PHONE_PICK_BYTES) {
          result.rejected.push({ fileName, reason: PHONE_LIMIT, code: "phoneLimit" });
          continue;
        }
        let bytes: Blob = file;
        if (!large) {
          // Our own copy of the bytes, read now: on Android a picked file is a reference whose
          // read permission can lapse, and every later write of it to IndexedDB then fails
          // (InvalidBlob).
          try {
            bytes = new Blob([await file.arrayBuffer()], { type: file.type });
          } catch {
            result.rejected.push({ fileName, reason: UNREADABLE_FILE, code: "unreadable" });
            continue;
          }
        }
        picked += file.size;
        await save({
          id: newId(),
          userId: owner,
          file: bytes,
          fileName,
          contentType,
          sizeBytes: file.size,
          photoId: null,
          status: "queued",
          attempts: 0,
          retryAt: 0,
          error: null,
          errorCode: null,
          addedAt: now(),
          ...(large && { memoryOnly: true }),
          ...(batch && { batchId: batch.batchId, sourceKey: fileKey(file) }),
        });
        result.added++;
        result.addedBytes += file.size;
        // Upload the first ones while the rest are still being read.
        pump();
      }
      if (result.added && !large && !persistenceRequested) {
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

    async pause() {
      const targets = [...items.values()].filter(
        (item) => !item.paused && (item.status === "queued" || item.status === "uploading"),
      );
      // All marked first (in memory at once), so a stopping upload's freed slot starts nothing.
      const writes = targets.map((item) =>
        update(item.id, { status: "queued", paused: true, retryAt: 0 }),
      );
      // Running uploads stop; they start over (re-signing the same photo, 5.6a) on resume.
      for (const item of targets) {
        active.get(item.id)?.abort();
        active.delete(item.id);
        progress.delete(item.id);
      }
      await Promise.all(writes);
      pump();
    },

    async resume() {
      for (const item of [...items.values()]) {
        if (item.paused) await update(item.id, { paused: false, retryAt: 0 });
      }
      pump();
    },

    async cancelAll() {
      for (const item of [...items.values()]) if (item.status !== "done") await forget(item.id);
      // Cancelled on purpose: nothing to continue later (13.1f).
      for (const batchId of [...liveBatches.keys()]) {
        liveBatches.delete(batchId);
        await batches?.delete(batchId).catch(() => {});
      }
    },

    async interruptedBatches() {
      return (await interruptedRecords()).map((record) => ({
        batchId: record.batchId,
        label: record.label,
        total: record.keys.length,
        remaining: record.keys.length - new Set(record.done).size,
      }));
    },

    async dismissBatch(batchId) {
      await batches?.delete(batchId);
    },

    getOtherTabsRemaining: () => otherTabsRemaining,

    async clear() {
      for (const controller of active.values()) controller.abort();
      items.clear();
      progress.clear();
      emit();
      liveBatches.clear();
      await Promise.all([store.clear(), batches?.clear()]);
      broadcast({ type: "changed" });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot,
  };
}
