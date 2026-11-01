import { MAX_UPLOAD_BYTES } from "@photo-app/shared";
import { CircleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { SkippedFile } from "./queue";
import type { SkipCode } from "./validate";

/** Group labels, in the order shown; `n` picks singular or plural. */
const GROUPS: Record<SkipCode, (n: number) => string> = {
  type: (n) => `${n === 1 ? "isn't a photo" : "aren't photos"} (videos and other files)`,
  size: () => `larger than ${formatBytes(MAX_UPLOAD_BYTES)}`,
  empty: (n) => (n === 1 ? "is empty" : "are empty"),
  unreadable: (n) =>
    `couldn't be read (if ${n === 1 ? "it's" : "they're"} in the cloud, download ${n === 1 ? "it" : "them"} first)`,
  phoneLimit: () => "over the 1 GB per pick on a phone: add them once these are uploaded",
};

/** File names listed at most when expanded; a folder can hold thousands of other files. */
export const MAX_LISTED = 200;

/**
 * What happened to a pick (13.1b, FR-UP-2/3): "530 added · 3 skipped", the skipped files grouped by
 * reason, and their names on request, instead of one line per file, which a folder with hundreds
 * of videos would turn into a wall of text.
 */
export function SkippedFiles({
  added,
  skipped,
  onDismiss,
}: {
  added: number;
  skipped: readonly SkippedFile[];
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const counts = new Map<SkipCode, number>();
  for (const file of skipped) counts.set(file.code, (counts.get(file.code) ?? 0) + 1);
  const groups = (Object.keys(GROUPS) as SkipCode[]).filter((code) => counts.has(code));
  const listed = skipped.slice(0, MAX_LISTED);

  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {added > 0 && `${added.toLocaleString()} added · `}
          {skipped.length === 1
            ? "1 file skipped"
            : `${skipped.length.toLocaleString()} files skipped`}
        </p>
        <ul className="text-muted-foreground">
          {groups.map((code) => {
            const n = counts.get(code)!;
            return (
              <li key={code}>
                {n.toLocaleString()} {GROUPS[code](n)}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="text-sm font-medium underline-offset-4 hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide the files" : "Show the files"}
        </button>
        {open && (
          <ul className="max-h-64 space-y-0.5 overflow-y-auto text-muted-foreground">
            {listed.map(({ fileName, reason }, i) => (
              <li key={i} className="truncate">
                {fileName}: {reason}
              </li>
            ))}
            {skipped.length > listed.length && (
              <li>and {(skipped.length - listed.length).toLocaleString()} more</li>
            )}
          </ul>
        )}
      </div>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
        <X aria-hidden />
      </Button>
    </div>
  );
}
