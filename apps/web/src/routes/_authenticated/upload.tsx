import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert, WifiOff, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { meQuery } from "@/queries/me";
import { SpaceWarning, StorageFullBanner } from "@/upload/QuotaNotices";
import type { AddResult } from "@/upload/queue";
import { UploadList } from "@/upload/UploadList";
import { UploadPicker } from "@/upload/UploadPicker";
import { isActive, useOnline, useUploadQueue, useUploads } from "@/upload/useUploads";

// Upload page / queue status (FR-UP-1/5/6, 8.10; storage full, FR-UP-7, 8.14).
export const Route = createFileRoute("/_authenticated/upload")({
  component: Upload,
});

function Upload() {
  const { api } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const queue = useUploadQueue();
  const entries = useUploads();
  const online = useOnline();
  // Not in a loader: the page works without it, it only feeds the storage notices.
  const { data: me } = useQuery(meQuery(api));
  const [rejected, setRejected] = useState<AddResult["rejected"]>([]);
  const [space, setSpace] = useState<{ needed: number; left: number } | null>(null);
  const pending = entries.some((entry) => entry.status === "queued");
  const storageFull = entries.filter(
    (entry) => entry.status === "failed" && entry.errorCode === "QUOTA_EXCEEDED",
  ).length;

  async function add(files: File[]) {
    // Space left after what is stored and what is already waiting to upload.
    const waiting = entries.filter(isActive).reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const result = await queue.add(files);
    setRejected(result.rejected);
    const left = me ? Math.max(me.usage.quotaBytes - me.usage.bytesUsed - waiting, 0) : Infinity;
    setSpace(result.addedBytes > left ? { needed: result.addedBytes, left } : null);
  }

  function retryAll() {
    setSpace(null);
    void queue.retryAll();
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
      <UploadPicker onFiles={(files) => void add(files)} />
      {storageFull > 0 && (
        <StorageFullBanner count={storageFull} usage={me?.usage} onRetry={retryAll} />
      )}
      {space && storageFull === 0 && (
        <SpaceWarning needed={space.needed} left={space.left} onDismiss={() => setSpace(null)} />
      )}
      {rejected.length > 0 && (
        <div
          role="alert"
          className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">
              {rejected.length === 1
                ? "1 file wasn't added"
                : `${rejected.length} files weren't added`}
            </p>
            <ul className="space-y-0.5 text-muted-foreground">
              {rejected.map(({ fileName, reason }, i) => (
                <li key={i} className="truncate">
                  {fileName}: {reason}
                </li>
              ))}
            </ul>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={() => setRejected([])}
          >
            <X aria-hidden />
          </Button>
        </div>
      )}
      {!online && pending && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <WifiOff aria-hidden className="size-4" />
          You're offline. Uploads continue when the connection is back.
        </p>
      )}
      {entries.length > 0 && <UploadList entries={entries} />}
    </main>
  );
}
