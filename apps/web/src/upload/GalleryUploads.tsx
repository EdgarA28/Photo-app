import { Link } from "@tanstack/react-router";
import { ImageOff, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QueueEntry } from "./queue";
import { ProgressBar } from "./UploadList";
import { BlobImage } from "./BlobImage";
import { canPreview } from "./useUploads";

/**
 * Queued, uploading and failed uploads at the top of the gallery (FR-UP-6), before the server
 * knows them as photos. Once uploaded they leave this strip and appear in the grid as processing.
 * Each tile links to /upload, where the queue can be managed.
 */
export function GalleryUploads({ entries }: { entries: readonly QueueEntry[] }) {
  const shown = entries.slice(0, MAX_TILES);
  const more = entries.length - shown.length;
  return (
    <section aria-label="Uploads" className="flex flex-wrap gap-1">
      {shown.map((entry) => (
        <UploadTile key={entry.id} entry={entry} />
      ))}
      {more > 0 && (
        <Link
          to="/upload"
          aria-label={`${more.toLocaleString()} more uploads`}
          className={cn(TILE_CLASS, "text-sm font-medium")}
        >
          +{more.toLocaleString()} more
        </Link>
      )}
    </section>
  );
}

/** Tiles shown at most; a big batch is summed up in a "+N more" tile (13.1-0). */
export const MAX_TILES = 20;

const TILE_CLASS =
  "relative flex size-28 items-center justify-center overflow-hidden bg-muted text-muted-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring sm:size-48";

const TILE_LABELS = {
  queued: "waiting to upload",
  uploading: "uploading",
  failed: "upload failed",
  done: "uploaded",
} as const;

function UploadTile({ entry }: { entry: QueueEntry }) {
  const failed = entry.status === "failed";
  const storageFull = failed && entry.errorCode === "QUOTA_EXCEEDED";
  return (
    <Link
      to="/upload"
      aria-label={`${entry.fileName}, ${storageFull ? "storage full" : TILE_LABELS[entry.status]}`}
      className={TILE_CLASS}
    >
      {canPreview(entry) && (
        <BlobImage file={entry.file} className="size-full object-cover opacity-60" />
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        {failed ? (
          <span className="flex flex-col items-center gap-1 rounded-md bg-background/80 px-2 py-1 text-xs font-medium text-destructive">
            <ImageOff aria-hidden className="size-5" />
            {storageFull ? "Storage full" : "Failed"}
          </span>
        ) : (
          <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" />
        )}
      </span>
      {entry.status === "uploading" && (
        <ProgressBar
          value={entry.progress}
          label={entry.fileName}
          className="absolute inset-x-2 bottom-2 bg-background/70"
        />
      )}
    </Link>
  );
}
