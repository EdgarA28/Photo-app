import { CircleAlert, Pause, Play, RotateCw, WifiOff, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { QueueEntry } from "./queue";
import { batchProgress, formatTimeLeft, useTimeLeft } from "./batchProgress";
import { useOnline, useUploadQueue } from "./useUploads";

/**
 * The queue on /upload (FR-UP-5/6): the whole batch as one progress bar, no list of files (user
 * request 2026-11-03), and a message when something went wrong: uploads that failed for good
 * (grouped by reason, with Retry and Remove) and uploads waiting to retry after a connection
 * problem. Storage-full failures have their own banner above (8.14), so they aren't repeated here.
 */
export function UploadList({ entries }: { entries: readonly QueueEntry[] }) {
  return (
    <section aria-labelledby="upload-queue" className="space-y-3">
      <BatchHeader entries={entries} />
      <UploadProblems entries={entries} />
    </section>
  );
}

/** "N photos couldn't be uploaded" with the reasons, and "retrying" after connection problems. */
function UploadProblems({ entries }: { entries: readonly QueueEntry[] }) {
  const queue = useUploadQueue();
  const online = useOnline();
  const failed = useMemo(
    () =>
      entries.filter((entry) => entry.status === "failed" && entry.errorCode !== "QUOTA_EXCEEDED"),
    [entries],
  );
  const reasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of failed) {
      const reason = entry.error ?? "Something went wrong.";
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts];
  }, [failed]);
  // Offline has its own note on the page; these are retries while the connection is there.
  const retrying = online
    ? entries.filter((entry) => entry.status === "queued" && !entry.paused && entry.attempts > 0)
        .length
    : 0;
  const photos = (n: number) => (n === 1 ? "1 photo" : `${n.toLocaleString()} photos`);

  return (
    <>
      {failed.length > 0 && (
        <div
          role="alert"
          className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <div className="flex items-start gap-3">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium">
                Something went wrong: {photos(failed.length)} couldn't be uploaded.
              </p>
              <ul className="space-y-0.5 text-muted-foreground">
                {reasons.map(([reason, count]) => (
                  <li key={reason}>
                    {reasons.length > 1 || count > 1 ? `${count.toLocaleString()} × ` : ""}
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void Promise.all(failed.map((entry) => queue.remove(entry.id)))}
            >
              <X aria-hidden />
              Remove
            </Button>
            <Button variant="outline" size="sm" onClick={() => void queue.retryAll()}>
              <RotateCw aria-hidden />
              Retry
            </Button>
          </div>
        </div>
      )}
      {retrying > 0 && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <WifiOff aria-hidden className="size-4 shrink-0" />
          Connection problem: {photos(retrying)} will be retried shortly.
        </p>
      )}
    </>
  );
}

/**
 * The whole queue at a glance (13.1d): "312 of 1,040 uploaded", the size and the time left at the
 * recent speed, an overall progress bar, and pause/resume and cancel for everything.
 */
function BatchHeader({ entries }: { entries: readonly QueueEntry[] }) {
  const queue = useUploadQueue();
  const online = useOnline();
  const batch = batchProgress(entries);
  const running = online && batch.active > 0;
  const timeLeft = useTimeLeft(batch.bytesDone, batch.bytesTotal - batch.bytesDone, running);
  const unfinished = batch.total - batch.done;
  const details = [
    batch.bytesTotal > 0 && `${formatBytes(batch.bytesDone)} of ${formatBytes(batch.bytesTotal)}`,
    batch.paused > 0 && batch.active === 0 && "Paused",
    timeLeft !== null && `${formatTimeLeft(timeLeft)} left`,
  ].filter(Boolean);

  return (
    <header className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="upload-queue" className="font-medium">
            {batch.done.toLocaleString()} of {batch.total.toLocaleString()} uploaded
          </h2>
          {unfinished > 0 && <p className="text-sm text-muted-foreground">{details.join(" · ")}</p>}
        </div>
        {unfinished > 0 && (
          <div className="flex shrink-0 gap-1">
            {batch.paused > 0 ? (
              <Button variant="outline" size="sm" onClick={() => void queue.resume()}>
                <Play aria-hidden />
                Resume
              </Button>
            ) : (
              batch.active > 0 && (
                <Button variant="outline" size="sm" onClick={() => void queue.pause()}>
                  <Pause aria-hidden />
                  Pause
                </Button>
              )
            )}
            <CancelAll count={unfinished} />
          </div>
        )}
      </div>
      {unfinished > 0 && batch.bytesTotal > 0 && (
        <ProgressBar value={batch.bytesDone / batch.bytesTotal} label="All uploads" />
      )}
    </header>
  );
}

/** Cancel every unfinished upload, after a confirmation (13.1d). */
function CancelAll({ count }: { count: number }) {
  const queue = useUploadQueue();
  const label = count === 1 ? "1 upload" : `${count.toLocaleString()} uploads`;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Cancel all
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Photos already uploaded stay. The others are removed from the queue; add them again to
            upload them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep uploading</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void queue.cancelAll()}>
            Cancel uploads
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ProgressBar({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const percent = Math.round(value * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-200"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
