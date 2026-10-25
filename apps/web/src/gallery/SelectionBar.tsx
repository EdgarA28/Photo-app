import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The bar of select mode (8.11): how many photos are picked, the actions for them, Cancel.
 * Fixed above the bottom tab bar on phones, at the bottom of the content from `md`.
 */
export function SelectionBar({
  count,
  onCancel,
  children,
}: {
  count: number;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 flex items-center gap-2 rounded-xl border bg-background/95 p-2 pl-4 shadow-lg backdrop-blur md:sticky md:inset-x-auto md:bottom-4"
    >
      <p aria-live="polite" className="mr-auto text-sm font-medium tabular-nums">
        {count === 0 ? "Select photos" : `${count} selected`}
      </p>
      {children}
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
