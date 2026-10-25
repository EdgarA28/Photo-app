import { CircleAlert, CircleCheck, ImageIcon, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { QueueEntry } from "./queue";
import { BlobImage } from "./BlobImage";
import { canPreview, useUploadQueue } from "./useUploads";

/** The queue on /upload (FR-UP-5/6): every file with its status, progress and actions. */
export function UploadList({ entries }: { entries: readonly QueueEntry[] }) {
  const queue = useUploadQueue();
  const done = entries.filter((entry) => entry.status === "done").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;

  return (
    <section aria-labelledby="upload-queue" className="space-y-3">
      <header className="flex items-center justify-between gap-3">
        <h2 id="upload-queue" className="font-medium">
          {done} of {entries.length} uploaded
        </h2>
        <div className="flex gap-1">
          {failed > 0 && (
            <Button variant="ghost" size="sm" onClick={() => void queue.retryAll()}>
              <RotateCw aria-hidden />
              Retry all failed
            </Button>
          )}
          {done > 0 && (
            <Button variant="ghost" size="sm" onClick={() => void queue.clearFinished()}>
              Clear finished
            </Button>
          )}
        </div>
      </header>
      <ul className="divide-y rounded-xl border">
        {entries.map((entry) => (
          <UploadRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function statusText(entry: QueueEntry): string {
  switch (entry.status) {
    case "queued":
      return entry.attempts > 0 ? "Connection problem, retrying soon" : "Waiting";
    case "uploading":
      return `Uploading ${Math.round(entry.progress * 100)}%`;
    case "done":
      return "Uploaded";
    case "failed":
      // Explained once in the storage-full banner above the list (8.14).
      return entry.errorCode === "QUOTA_EXCEEDED"
        ? "Not enough storage"
        : (entry.error ?? "Failed");
  }
}

function UploadRow({ entry }: { entry: QueueEntry }) {
  const queue = useUploadQueue();
  const failed = entry.status === "failed";

  return (
    <li className="flex items-center gap-3 p-3">
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
        {canPreview(entry) ? (
          <BlobImage file={entry.file} className="size-full object-cover" />
        ) : (
          <ImageIcon aria-hidden className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium" title={entry.fileName}>
          {entry.fileName}
        </p>
        <p className={cn("text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
          {formatBytes(entry.sizeBytes)} · {statusText(entry)}
        </p>
        {entry.status === "uploading" && (
          <ProgressBar value={entry.progress} label={entry.fileName} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {entry.status === "done" && (
          <CircleCheck aria-label="Uploaded" className="size-5 text-primary" />
        )}
        {failed && (
          <>
            <CircleAlert aria-hidden className="size-5 text-destructive" />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Retry ${entry.fileName}`}
              onClick={() => void queue.retry(entry.id)}
            >
              <RotateCw aria-hidden />
            </Button>
          </>
        )}
        {entry.status !== "done" && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${failed ? "Remove" : "Cancel"} ${entry.fileName}`}
            onClick={() => void queue.remove(entry.id)}
          >
            <X aria-hidden />
          </Button>
        )}
      </div>
    </li>
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
