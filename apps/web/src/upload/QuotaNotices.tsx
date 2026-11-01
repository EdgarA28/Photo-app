import type { Usage } from "@photo-app/shared";
import { Link } from "@tanstack/react-router";
import { HardDrive, RotateCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
 * The picked files need more space than is left (FR-UP-7, 13.1e): asked before anything is
 * queued, so a big folder doesn't run for hours only to stop at "storage full". "Upload anyway"
 * still queues them all: the server has the final say, and photos may be deleted meanwhile; the
 * queue stops the rest at the first refusal.
 */
export function SpaceConfirm({
  needed,
  left,
  onUpload,
  onCancel,
}: {
  needed: number;
  left: number;
  onUpload: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Not enough storage for all of these</AlertDialogTitle>
          <AlertDialogDescription>
            These photos need {formatBytes(needed)}, but only {formatBytes(left)} is left. Uploads
            stop once your storage is full; free up space first, or upload anyway.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onUpload}>Upload anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
