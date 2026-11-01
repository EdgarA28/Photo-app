import { History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InterruptedBatch } from "./batches";

const photos = (n: number) => (n === 1 ? "1 photo" : `${n.toLocaleString()} photos`);

/**
 * Large batches whose tab was closed or reloaded before they finished (13.1f): how many photos
 * weren't uploaded, and how to go on — picking the same folder again uploads only the rest.
 */
export function InterruptedBatches({
  batches,
  onDismiss,
}: {
  batches: readonly InterruptedBatch[];
  onDismiss: (batchId: string) => void;
}) {
  return (
    <>
      {batches.map((batch) => (
        <div
          key={batch.batchId}
          role="status"
          className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <History aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-medium">
              {batch.label
                ? `${photos(batch.remaining)} from “${batch.label}” weren't uploaded`
                : `${photos(batch.remaining)} of ${batch.total.toLocaleString()} weren't uploaded`}
            </p>
            <p className="text-muted-foreground">
              The upload stopped when its tab was closed.{" "}
              {batch.label
                ? "Choose the folder again to continue: photos already uploaded are skipped."
                : "Pick the same photos again to continue: those already uploaded are skipped."}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={() => onDismiss(batch.batchId)}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
    </>
  );
}
