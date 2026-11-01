import { Laptop, Signal } from "lucide-react";
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
import type { MeteredReason } from "@/lib/connection";
import { formatBytes } from "@/lib/format";

/** A pick at least this big asks first on mobile data or with Data Saver on (13.1l). */
export const MOBILE_DATA_WARN_BYTES = 200 * 1024 * 1024;

/** Asks before uploading a big pick over mobile data (13.1l). */
export function MobileDataConfirm({
  reason,
  bytes,
  onUpload,
  onCancel,
}: {
  reason: MeteredReason;
  bytes: number;
  onUpload: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Upload over mobile data?</AlertDialogTitle>
          <AlertDialogDescription>
            {reason === "cellular"
              ? `You're on mobile data. These photos are ${formatBytes(bytes)}, which counts toward your data plan.`
              : `Data Saver is on. These photos are ${formatBytes(bytes)}.`}{" "}
            Upload now, or wait until you're on Wi-Fi.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={onUpload}>Upload anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** While uploads run on mobile data (13.1l): the connection may have changed since the pick. */
export function MobileDataNote() {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Signal aria-hidden className="size-4 shrink-0" />
      Uploading over mobile data.
    </p>
  );
}

/** On phones (13.1l): big imports are a job for a computer, and phones pause in the background. */
export function PhoneHint() {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Laptop aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        Moving a whole photo library? It's easier on a computer, where you can choose folders. On a
        phone, keep the app open until uploads finish: phones may pause them in the background.
      </span>
    </p>
  );
}
