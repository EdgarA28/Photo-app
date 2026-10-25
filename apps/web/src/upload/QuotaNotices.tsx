import type { Usage } from "@photo-app/shared";
import { Link } from "@tanstack/react-router";
import { CircleAlert, HardDrive, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";

const photosText = (count: number) => (count === 1 ? "1 photo" : `${count} photos`);

/**
 * Uploads refused because the quota is used up (FR-UP-7), explained once instead of on every row:
 * how many, the current usage, where to free up space, and retrying them all afterwards.
 */
export function StorageFullBanner({
  count,
  usage,
  onRetry,
}: {
  count: number;
  usage: Usage | undefined;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <HardDrive aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <p className="font-medium">Storage full: {photosText(count)} couldn't be uploaded</p>
          <p className="text-muted-foreground">
            {usage && `${formatBytes(usage.bytesUsed)} of ${formatBytes(usage.quotaBytes)} used. `}
            Delete photos you no longer need, then try again.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/gallery">Free up space in the Gallery</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden />
            Retry all
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The picked files are larger than the space left (FR-UP-7). A warning, not a refusal: the server
 * has the final say, and photos may be deleted while the uploads wait.
 */
export function SpaceWarning({
  needed,
  left,
  onDismiss,
}: {
  needed: number;
  left: number;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <p className="min-w-0 flex-1">
        These photos need {formatBytes(needed)}, but only {formatBytes(left)} is left. Some won't
        upload until you free up space.
      </p>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
        <X aria-hidden />
      </Button>
    </div>
  );
}
