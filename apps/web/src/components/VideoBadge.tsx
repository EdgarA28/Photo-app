import { Play } from "lucide-react";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The play mark and length on a video's tile (FR-VID-4, 14.6): gallery, album, trash, map and
 * public link tiles. Decorative: the tile's label says "Video, 1:05" (`videoLabel`).
 */
export function VideoBadge({
  durationMs,
  className,
}: {
  durationMs: number | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-video-badge
      className={cn(
        "pointer-events-none absolute right-1 bottom-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[0.6875rem] leading-none font-medium text-white tabular-nums",
        className,
      )}
    >
      <Play className="size-2.5 fill-current" />
      {durationMs !== null && formatDuration(durationMs)}
    </span>
  );
}
