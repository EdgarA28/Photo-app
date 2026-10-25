import type { Api } from "@/api/api";
import { ApiRequestError, errorMessage } from "@/api/errors";
import { postToS3, S3UploadError, type PostToS3 } from "./s3Post";
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
  /** Loads the user's queue and starts uploading (if this tab holds the lock). Idempotent per user. */
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
  /** Asks the browser not to evict the queued files (iOS evicts storage of unused sites). */
  requestPersistence?: () => unknown;
  now?: () => number;
  newId?: () => string;
}

/** §12.4: 3 parallel uploads. */
export const CONCURRENCY = 3;
/** Backoff after a temporary failure: 2 s, 4 s, 8 s … capped at 1 min. */
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 60_000;
export const retryDelay = (attempts: number) =>
  Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

const LOCK_NAME = "photo-app-uploads";
/** BroadcastChannel name for `createChannel` in the app. */
export const UPLOAD_CHANNEL_NAME = "photo-app-uploads";
/** Progress messages to other tabs at most this often. */
const PROGRESS_BROADCAST_MS = 250;
/** The uploading tab tells the others it's alive this often. */
export const HEARTBEAT_MS = 3000;
/**
 * A visible tab with waiting uploads takes the lock over after this long without a word from the
 * uploading tab. A background tab is throttled or frozen (on Android as soon as another app
 * window, e.g. the installed PWA, is in front) and would otherwise keep everyone waiting.
 */
export const TAKEOVER_AFTER_MS = 10_000;

type Message =
  { type: "changed" } | { type: "progress"; id: string; progress: number } | { type: "alive" };

class FileMissingError extends Error {
  constructor() {
    super("The file is no longer available on this device. Add it again.");
  }
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * The upload queue (§12.4, FR-UP-1/5/6). Files are stored in IndexedDB first, then a worker loop
 * uploads them: request upload URL → POST straight to S3 with progress → done → refresh the
 * gallery. Temporary failures (network, 5xx, expired signature) retry with backoff, on the
 * `online` event and on app start; permanent ones (validation, quota) wait for the user.
 *
 * Every attempt asks for a fresh signature (an old one has likely expired), passing the stored
 * `photoId` after the first, so a retry re-signs the same pending photo instead of creating a
 * duplicate (5.6a). Only the tab holding the Web Lock uploads; all tabs share the stored queue
 * and hear about changes over a BroadcastChannel.
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
  /** Leader: the heartbeat. Others: the check whether the leader went quiet. */
  let ticker: ReturnType<typeof setInterval> | undefined;
  /** When the uploading tab was last heard from (heartbeat or progress). */
  let lastAlive = 0;
  let persistenceRequested = false;

  const items = new Map<string, UploadItem>();
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

  function broadcast(message: Message) {
    channel?.postMessage(message);
  }

  async function save(item: UploadItem) {
    items.set(item.id, item);
    emit();
    await store.put(item);
    broadcast({ type: "changed" });
  }

  /** Applies a change to an item still in the queue (it may have been removed meanwhile). */
  async function update(id: string, patch: Partial<UploadItem>) {
    const current = items.get(id);
    if (current) await save({ ...current, ...patch });
  }

  /** Reads the stored queue, keeping this tab's running uploads as it knows them. */
  async function reload() {
    if (!userId) return;
    const forSession = session;
    const stored = await store.list(userId);
    if (forSession !== session) return;
    const storedIds = new Set(stored.map((item) => item.id));
    for (const [id, controller] of active) if (!storedIds.has(id)) controller.abort();
    const known = new Map(items);
    items.clear();
    for (const item of stored) {
      items.set(item.id, (active.has(item.id) && known.get(item.id)) || item);
    }
    emit();
  }

  function onMessage(event: MessageEvent<Message>) {
    const message = event.data;
    if (message.type === "alive") {
      lastAlive = now();
    } else if (message.type === "progress") {
      lastAlive = now();
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
    broadcast({ type: "alive" });
    ticker = setInterval(() => broadcast({ type: "alive" }), HEARTBEAT_MS);
    await reload();
    if (forSession !== session) return;
    for (const item of [...items.values()]) {
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
      if (!item?.file) throw new FileMissingError();
      const { photoId, upload } = await api.photos.uploadUrl({
        fileName: item.fileName,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        ...(item.photoId ? { photoId: item.photoId } : {}),
      });
      if (signal.aborted) return;
      if (photoId !== item.photoId) await update(id, { photoId });
      await post(upload, item.file, {
        signal,
        onProgress: (fraction) => {
          if (signal.aborted) return;
          progress.set(id, fraction);
          emit();
          const t = now();
          if (fraction === 1 || t - (lastProgressBroadcast.get(id) ?? 0) >= PROGRESS_BROADCAST_MS) {
            lastProgressBroadcast.set(id, t);
            broadcast({ type: "progress", id, progress: fraction });
          }
        },
      });
      if (signal.aborted) return;
      await onUploaded?.();
      await finish(id);
    } catch (error) {
      if (signal.aborted || isAbort(error)) return;
      await fail(id, error);
    } finally {
      if (active.get(id) === controller) active.delete(id);
      progress.delete(id);
      lastProgressBroadcast.delete(id);
      pump();
    }
  }

  const finish = (id: string) =>
    update(id, { status: "done", file: null, retryAt: 0, error: null, errorCode: null });

  async function fail(id: string, error: unknown) {
    const item = items.get(id);
    if (!item) return;
    const later = () => {
      const attempts = item.attempts + 1;
      return update(id, { status: "queued", attempts, retryAt: now() + retryDelay(attempts) });
    };

    if (error instanceof ApiRequestError) {
      // Re-signing a photo that is gone (deleted, or swept as abandoned by 6.11): start afresh.
      if (error.status === 404 && item.photoId) {
        return update(id, { status: "queued", photoId: null, retryAt: 0 });
      }
      // No longer pending: an earlier attempt reached S3 even though its answer got lost.
      if (error.status === 409 && item.photoId) {
        await onUploaded?.();
        return finish(id);
      }
      // The client already sent the user to /login; the upload continues after it.
      if (error.code === "UNAUTHORIZED" || error.retryable) return later();
      return update(id, { status: "failed", error: errorMessage(error), errorCode: error.code });
    } else if (error instanceof S3UploadError) {
      if (error.retryable) return later();
      // The signed POST pins the exact size: an edited file is the usual cause.
      return update(id, {
        status: "failed",
        error:
          "This file couldn't be uploaded. It may have changed since you picked it. Remove it and add it again.",
        errorCode: "S3_REJECTED",
      });
    } else if (error instanceof FileMissingError) {
      return update(id, { status: "failed", error: error.message, errorCode: "FILE_MISSING" });
    }
    return update(id, { status: "failed", error: errorMessage(error), errorCode: "UNKNOWN" });
  }

  async function forget(id: string) {
    active.get(id)?.abort();
    items.delete(id);
    progress.delete(id);
    emit();
    await store.delete(id);
    broadcast({ type: "changed" });
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
    // Before the request: a lock granted at once starts the heartbeat inside it.
    clearInterval(ticker);
    ticker = undefined;
    // A steal is granted at once (then lead() starts the heartbeat); checking again meanwhile
    // would steal from itself. Waiting: give the leader a full period before calling it quiet.
    if (!steal) {
      lastAlive = now();
      ticker = setInterval(checkTakeover, HEARTBEAT_MS);
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
    if (leader || !userId || !isVisible()) return;
    const waiting = [...items.values()].some(
      (item) => item.status === "queued" || item.status === "uploading",
    );
    if (waiting && now() - lastAlive >= TAKEOVER_AFTER_MS) requestLock(session, true);
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

  function stop() {
    session++;
    clearTimeout(timer);
    clearInterval(ticker);
    ticker = undefined;
    document.removeEventListener("visibilitychange", onVisibilityChange);
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

  return {
    async start(nextUserId) {
      if (userId === nextUserId) return;
      stop();
      userId = nextUserId;
      const forSession = session;
      channel = createChannel?.();
      channel?.addEventListener("message", onMessage);
      window.addEventListener("online", onOnline);
      await reload();
      if (forSession !== session) return;

      if (!locks) return lead(forSession);
      document.addEventListener("visibilitychange", onVisibilityChange);
      requestLock(forSession);
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
        await save({
          id: newId(),
          userId: owner,
          file,
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
