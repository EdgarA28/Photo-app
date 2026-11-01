import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import type { QueueEntry, UploadQueue } from "./queue";

export function useUploadQueue(): UploadQueue {
  return useRouteContext({ from: "__root__", select: (context) => context.uploads });
}

/** The live queue (FR-UP-6). */
export function useUploads(): readonly QueueEntry[] {
  const queue = useUploadQueue();
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot);
}

/** Photos of a large batch other tabs are still uploading (13.1d). */
export function useOtherTabsUploading(): number {
  const queue = useUploadQueue();
  return useSyncExternalStore(queue.subscribe, queue.getOtherTabsRemaining);
}

/** Waiting or running: what the nav badge counts. */
export const isActive = (entry: QueueEntry) =>
  entry.status === "queued" || entry.status === "uploading";

/** Whether the browser can show an image of this type itself: most can't display HEIC. */
export const canPreviewType = (type: string) =>
  type.startsWith("image/") && type !== "image/heic" && type !== "image/heif";

/** Whether the browser can show the queued file itself. */
export const canPreview = (entry: QueueEntry): entry is QueueEntry & { file: Blob } =>
  entry.file !== null && canPreviewType(entry.contentType);

const subscribeOnline = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};

/** The browser's connection state; uploads wait while offline (FR-UP-5). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}

/** Part of this tab's large batch and not finished: lost if the tab closes (13.1c). */
export const isInTabOnly = (entry: QueueEntry) => entry.memoryOnly === true && isActive(entry);

/**
 * While this tab uploads a large batch (13.1c), which only it can finish: the browser asks before
 * the tab is closed or reloaded, and the screen is kept on where supported (Screen Wake Lock), so
 * the device doesn't sleep in the middle of a long upload. The lock is dropped by the browser when
 * the tab is hidden, so it is asked for again when the tab comes back.
 */
export function useLargeBatchGuard(): void {
  const running = useUploads().some(isInTabOnly);
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need it set; the text itself isn't shown.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);

    let lock: { release(): Promise<void> } | undefined;
    let ended = false;
    const keepAwake = () => {
      const wakeLock = (
        navigator as {
          wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
        }
      ).wakeLock;
      if (!wakeLock || document.visibilityState !== "visible") return;
      wakeLock.request("screen").then(
        (granted) => (ended ? void granted.release() : (lock = granted)),
        () => {}, // Not allowed (e.g. battery saver): uploads carry on anyway.
      );
    };
    keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    return () => {
      ended = true;
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("visibilitychange", keepAwake);
      void lock?.release().catch(() => {});
    };
  }, [running]);
}
