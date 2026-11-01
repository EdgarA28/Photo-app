import { MAX_UPLOAD_BYTES } from "@photo-app/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert, MonitorUp, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { MAX_SHARED_BYTES, MAX_SHARED_FILES } from "@/pwa/shareTarget";
import { meQuery } from "@/queries/me";
import { SpaceConfirm, StorageFullBanner } from "@/upload/QuotaNotices";
import type { AddOptions, AddResult } from "@/upload/queue";
import { UploadList } from "@/upload/UploadList";
import type { WaitingPhoto } from "@/upload/shareInbox";
import { SharedPhotos } from "@/upload/SharedPhotos";
import type { InterruptedBatch } from "@/upload/batches";
import { InterruptedBatches } from "@/upload/InterruptedBatches";
import { SkippedFiles } from "@/upload/SkippedFiles";
import { UploadPicker } from "@/upload/UploadPicker";
import { checkFile } from "@/upload/validate";
import {
  isActive,
  isInTabOnly,
  useOnline,
  useOtherTabsUploading,
  useUploadQueue,
  useUploads,
} from "@/upload/useUploads";

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
  /** The last pick's outcome, while it skipped files (13.1b). */
  const [picked, setPicked] = useState<Pick<AddResult, "added" | "rejected"> | null>(null);
  /** Files of an interrupted batch picked again that were uploaded already (13.1f). */
  const [alreadyUploaded, setAlreadyUploaded] = useState(0);
  const [interrupted, setInterrupted] = useState<InterruptedBatch[]>([]);
  /** A pick that needs more space than is left, waiting for the user's go-ahead (13.1e). */
  const [tooBig, setTooBig] = useState<{
    files: File[];
    options: AddOptions | undefined;
    needed: number;
    left: number;
  } | null>(null);
  const [shareFailed, setShareFailed] = useState(shared === "failed");
  const [shareSkipped, setShareSkipped] = useState(skipped ?? 0);
  const [sharedPhotos, setSharedPhotos] = useState<WaitingPhoto[]>([]);
  const [sharing, setSharing] = useState(false);
  const pending = entries.some((entry) => entry.status === "queued");
  const inTabOnly = entries.filter(isInTabOnly).length;
  const otherTabs = useOtherTabsUploading();
  const storageFull = entries.filter(
    (entry) => entry.status === "failed" && entry.errorCode === "QUOTA_EXCEEDED",
  ).length;

  /**
   * Queues a pick, after asking if it needs more space than is left (13.1e): what is stored plus
   * what is already waiting to upload. Without usage (offline, not loaded yet) it just queues.
   */
  async function add(files: File[], options?: AddOptions) {
    const waiting = entries.filter(isActive).reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const left = me ? Math.max(me.usage.quotaBytes - me.usage.bytesUsed - waiting, 0) : Infinity;
    // Only what would be queued counts: no videos or other skipped files.
    const needed = files.reduce((sum, file) => sum + (checkFile(file).ok ? file.size : 0), 0);
    if (needed > left) {
      setTooBig({ files, options, needed, left });
      return;
    }
    await queueFiles(files, options);
  }

  async function queueFiles(files: File[], options?: AddOptions) {
    const result = await queue.add(files, options);
    setPicked(result.rejected.length ? result : null);
    setAlreadyUploaded(result.alreadyUploaded ?? 0);
    void loadInterrupted();
  }

  /** Large batches stopped by a closed tab, to continue (13.1f). */
  async function loadInterrupted() {
    try {
      await queue.start(user.sub);
      setInterrupted(await queue.interruptedBatches());
    } catch (error) {
      console.warn("Reading the interrupted uploads failed", error);
    }
  }

  async function dismissBatch(batchId: string) {
    setInterrupted((batches) => batches.filter((batch) => batch.batchId !== batchId));
    await queue.dismissBatch(batchId).catch(() => {});
  }

  // On opening the page: the queue starts with the layout, which runs after this page's effects.
  useEffect(() => {
    void loadInterrupted();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit
  }, []);

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
      {interrupted.length > 0 && (
        <InterruptedBatches batches={interrupted} onDismiss={(id) => void dismissBatch(id)} />
      )}
      <UploadPicker onFiles={(files, options) => void add(files, options)} />
      {alreadyUploaded > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {alreadyUploaded === 1
            ? "1 photo was uploaded before and was skipped."
            : `${alreadyUploaded.toLocaleString()} photos were uploaded before and were skipped.`}
        </p>
      )}
      {storageFull > 0 && (
        <StorageFullBanner count={storageFull} usage={me?.usage} onRetry={retryAll} />
      )}
      {tooBig && (
        <SpaceConfirm
          needed={tooBig.needed}
          left={tooBig.left}
          onCancel={() => setTooBig(null)}
          onUpload={() => {
            setTooBig(null);
            void queueFiles(tooBig.files, tooBig.options);
          }}
        />
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
      {picked && (
        <SkippedFiles
          added={picked.added}
          skipped={picked.rejected}
          onDismiss={() => setPicked(null)}
        />
      )}
      {otherTabs > 0 && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <MonitorUp aria-hidden className="size-4 shrink-0" />
          Uploading {otherTabs === 1 ? "1 photo" : `${otherTabs.toLocaleString()} photos`} in
          another tab.
        </p>
      )}
      {inTabOnly > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl border bg-muted/40 p-3 text-sm"
        >
          <MonitorUp aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Large upload: keep this tab open until it's done. Closing or reloading it stops the
            remaining {inTabOnly === 1 ? "photo" : `${inTabOnly.toLocaleString()} photos`}.
          </span>
        </p>
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
