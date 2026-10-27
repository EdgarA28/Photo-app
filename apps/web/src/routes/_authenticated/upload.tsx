import { MAX_UPLOAD_BYTES } from "@photo-app/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { MAX_SHARED_BYTES, MAX_SHARED_FILES } from "@/pwa/shareTarget";
import { meQuery } from "@/queries/me";
import { SpaceWarning, StorageFullBanner } from "@/upload/QuotaNotices";
import type { AddResult } from "@/upload/queue";
import { UploadList } from "@/upload/UploadList";
import type { WaitingPhoto } from "@/upload/shareInbox";
import { SharedPhotos } from "@/upload/SharedPhotos";
import { UploadPicker } from "@/upload/UploadPicker";
import { isActive, useOnline, useUploadQueue, useUploads } from "@/upload/useUploads";

/**
 * `shared`: arriving from Android's share sheet (9.6, FR-PWA-4), set by the service worker's
 * redirect (pwa/shareTarget.ts); `skipped`: shared files it left out (type, size, limits; 9.8).
 * Anything else is ignored.
 */
const uploadSearchSchema = z.object({
  shared: z.enum(["received", "failed"]).optional().catch(undefined),
  skipped: z.coerce.number().int().positive().optional().catch(undefined),
});

// Upload page / queue status (FR-UP-1/5/6, 8.10; storage full, FR-UP-7, 8.14).
export const Route = createFileRoute("/_authenticated/upload")({
  validateSearch: uploadSearchSchema,
  component: Upload,
});

function Upload() {
  const { api, shareInbox, user } = Route.useRouteContext();
  const { shared, skipped } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const queue = useUploadQueue();
  const entries = useUploads();
  const online = useOnline();
  // Not in a loader: the page works without it, it only feeds the storage notices.
  const { data: me } = useQuery(meQuery(api));
  const [rejected, setRejected] = useState<AddResult["rejected"]>([]);
  const [space, setSpace] = useState<{ needed: number; left: number } | null>(null);
  const [shareFailed, setShareFailed] = useState(shared === "failed");
  const [shareSkipped, setShareSkipped] = useState(skipped ?? 0);
  const [sharedPhotos, setSharedPhotos] = useState<WaitingPhoto[]>([]);
  const [sharing, setSharing] = useState(false);
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

  // Shared photos (9.6) wait in the inbox, through a login if needed, until the user uploads or
  // discards them: never added unasked, since any website can POST to the share target (CSRF).
  useEffect(() => {
    let cancelled = false;
    shareInbox.list().then(
      (photos) => !cancelled && setSharedPhotos(photos),
      (error: unknown) => console.warn("Reading the shared photos failed", error),
    );
    // A reload or Back mustn't show the "couldn't be received" message again.
    if (shared) void navigate({ search: {}, replace: true });
    return () => {
      cancelled = true;
    };
  }, [shareInbox, shared, navigate]);

  async function decideShared(upload: boolean) {
    setSharing(true);
    try {
      if (upload) await queue.start(user.sub);
      // Exactly the photos shown (9.8), removed as they are taken, so they are added at most once.
      const files = await shareInbox.take(sharedPhotos.map((photo) => photo.id));
      if (upload) await add(files);
      // A newer share may have arrived meanwhile: it is offered on its own.
      setSharedPhotos(await shareInbox.list());
    } catch (error) {
      console.warn("Handling the shared photos failed", error);
      setShareFailed(true);
    } finally {
      setSharing(false);
    }
  }

  function retryAll() {
    setSpace(null);
    void queue.retryAll();
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
      {sharedPhotos.length > 0 && (
        <SharedPhotos
          files={sharedPhotos.map((photo) => photo.file)}
          busy={sharing}
          onUpload={() => void decideShared(true)}
          onDiscard={() => void decideShared(false)}
        />
      )}
      <UploadPicker onFiles={(files) => void add(files)} />
      {storageFull > 0 && (
        <StorageFullBanner count={storageFull} usage={me?.usage} onRetry={retryAll} />
      )}
      {space && storageFull === 0 && (
        <SpaceWarning needed={space.needed} left={space.left} onDismiss={() => setSpace(null)} />
      )}
      {shareFailed && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
          <p className="flex-1">The shared photos couldn't be received. Share them again.</p>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={() => setShareFailed(false)}
          >
            <X aria-hidden />
          </Button>
        </div>
      )}
      {shareSkipped > 0 && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
          <p className="flex-1">
            {shareSkipped === 1
              ? "1 shared file was left out: "
              : `${shareSkipped} shared files were left out: `}
            only JPEG, PNG, WebP or HEIC photos up to {formatBytes(MAX_UPLOAD_BYTES)}, at most{" "}
            {MAX_SHARED_FILES} or {formatBytes(MAX_SHARED_BYTES)} per share.
          </p>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={() => setShareSkipped(0)}
          >
            <X aria-hidden />
          </Button>
        </div>
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
