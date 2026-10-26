import type { Api } from "@/api/api";
import type { StoredSession } from "@/auth/sessionDb";
import { attemptUpload, isAbort } from "@/upload/attempt";
import { CONCURRENCY, LOCK_NAME, TAKEOVER_AFTER_MS, type UploadMessage } from "@/upload/queue";
import type { PostToS3 } from "@/upload/s3Post";
import type { UploadItem, UploadStore } from "@/upload/store";

/**
 * Chromium ends a sync event after 3 minutes; stop starting and running uploads before that, so
 * the stored queue is left consistent and the browser schedules a retry.
 */
export const SYNC_TIME_BUDGET_MS = 150_000;
/** How often the service worker tells open tabs it is still uploading (it has no progress). */
export const WORKING_INTERVAL_MS = 3000;

export interface BackgroundUploadDeps {
  /** The signed-in user (refresh token + `sub`), from the session database. */
  readSession: () => Promise<StoredSession | null>;
  /** The API acting for that session; `ended` once Cognito rejects its refresh token. */
  connect: (session: StoredSession) => {
    api: Pick<Api, "photos">;
    auth: { readonly ended: boolean };
  };
  store: UploadStore;
  post: PostToS3;
  locks: LockManager;
  createChannel?: (() => BroadcastChannel) | undefined;
  now?: () => number;
}

const isWaiting = (item: UploadItem) => item.status === "queued" || item.status === "uploading";

/**
 * Background Sync for the upload queue (9.5, §12.4, Chromium only): runs in the service worker
 * when the browser fires the `sync` a hidden tab asked for, i.e. once the device is online, even
 * if the app is closed. Uploads the stored queue with the same steps as the page (attempt.ts),
 * without progress, 3 at a time, as the signed-in user.
 *
 * Holds the same Web Lock as the tabs: a free lock means no tab is uploading (the app is closed).
 * A held one is left alone while its tab makes progress, and taken over after `TAKEOVER_AFTER_MS`
 * without it (Android freezes a backgrounded app's uploads), as between tabs. A tab that comes
 * back takes the lock back the same way only if this worker stops reporting `working`.
 *
 * Resolves when nothing is left to do now: all done or failed for good, a tab is uploading or
 * took over, or the session ended (the app asks for a login). Rejects when uploads wait for a
 * retry (temporary failure, or out of time), which makes the browser fire the sync again later
 * (Chromium: after 5 and 15 minutes, then it gives up until a tab asks again).
 */
export async function uploadInBackground({
  readSession,
  connect,
  store,
  post,
  locks,
  createChannel,
  now = Date.now,
}: BackgroundUploadDeps): Promise<void> {
  const session = await readSession();
  if (!session) return;
  if (!(await store.list(session.sub)).some(isWaiting)) return;

  const channel = createChannel?.();
  const stop = new AbortController();
  const outOfTime = setTimeout(() => stop.abort(), SYNC_TIME_BUDGET_MS);
  /** Uploads running here, so one removed in a tab meanwhile is cancelled. */
  const active = new Map<string, AbortController>();
  /** Resolves to whether uploads are left for a retry. */
  let work: Promise<boolean> | undefined;

  const broadcast = (message: UploadMessage) => channel?.postMessage(message);

  channel?.addEventListener("message", (event: MessageEvent<UploadMessage>) => {
    if (event.data.type === "changed") void cancelRemoved();
  });

  async function cancelRemoved() {
    const ids = new Set((await store.list(session!.sub)).map((item) => item.id));
    for (const [id, controller] of active) if (!ids.has(id)) controller.abort();
  }

  /** Whether the tab holding the lock reports upload progress within the takeover time. */
  function tabIsUploading() {
    if (!channel) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), TAKEOVER_AFTER_MS);
      const onMessage = (event: MessageEvent<UploadMessage>) => {
        if (event.data.type === "progress") finish(true);
      };
      function finish(uploading: boolean) {
        clearTimeout(timer);
        channel!.removeEventListener("message", onMessage);
        resolve(uploading);
      }
      channel.addEventListener("message", onMessage);
    });
  }

  /** Applies a change to an item still in the stored queue; null if a tab removed it. */
  async function write(id: string, patch: Partial<UploadItem>) {
    const current = (await store.list(session!.sub)).find((item) => item.id === id);
    if (!current) return null;
    const next = { ...current, ...patch };
    await store.put(next);
    broadcast({ type: "changed" });
    return next;
  }

  /** One item; true if it waits for a retry. */
  async function upload(id: string, api: Pick<Api, "photos">): Promise<boolean> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    stop.signal.addEventListener("abort", cancel);
    active.set(id, controller);
    try {
      const item = await write(id, { status: "uploading", error: null, errorCode: null });
      if (!item) return false;
      const result = await attemptUpload(
        item,
        { api, post, now },
        {
          signal: controller.signal,
          onPhotoId: (photoId) => write(id, { photoId }).then(() => {}),
        },
      );
      // Cancelled: left as `uploading`, which the next uploader (tab or sync) starts again.
      if (!result) return stop.signal.aborted;
      await write(id, result.patch);
      return result.patch.status === "queued";
    } finally {
      active.delete(id);
      stop.signal.removeEventListener("abort", cancel);
    }
  }

  async function drain(): Promise<boolean> {
    const { api, auth } = connect(session!);
    const queue = (await store.list(session!.sub)).filter(isWaiting);
    let retry = false;
    broadcast({ type: "working" });
    const working = setInterval(() => broadcast({ type: "working" }), WORKING_INTERVAL_MS);
    try {
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          if (stop.signal.aborted || auth.ended) return;
          if (await upload(item.id, api)) retry = true;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      clearInterval(working);
    }
    // Session over: nothing to retry until the user logs in again in the app.
    if (auth.ended) return false;
    return retry || stop.signal.aborted;
  }

  const hold = (lock: Lock | null) => {
    if (!lock) return false;
    work = drain();
    return work.then(() => true);
  };

  let retry: boolean;
  try {
    if (!(await locks.request(LOCK_NAME, { ifAvailable: true }, hold))) {
      if (await tabIsUploading()) return;
      await locks.request(LOCK_NAME, { steal: true }, hold);
    }
    retry = await work!;
  } catch (error) {
    if (!isAbort(error)) throw error;
    // A tab took the lock over (the app was opened): it carries on from the stored queue.
    stop.abort();
    await work;
    return;
  } finally {
    clearTimeout(outOfTime);
    channel?.close();
  }
  if (retry) throw new Error("Uploads are waiting for a retry");
}
