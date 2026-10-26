import { useRouteContext } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import type { QueueEntry, UploadQueue } from "./queue";

export function useUploadQueue(): UploadQueue {
  return useRouteContext({ from: "__root__", select: (context) => context.uploads });
}

/** The live queue (FR-UP-6). */
export function useUploads(): readonly QueueEntry[] {
  const queue = useUploadQueue();
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot);
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
