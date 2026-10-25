import type { Usage } from "@photo-app/shared";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** From these shares of the quota the bar warns (amber), then alerts (red) with a hint. */
const QUOTA_WARN = 0.8;
const QUOTA_FULL = 0.95;

/**
 * Storage used against the quota (FR-ACC-1). Counts stored photos (`bytesUsed`); uploads in
 * progress are reserved on the server (5.6b) but `GET /me` doesn't report them.
 */
export function QuotaBar({ usage }: { usage: Usage }) {
  const share = Math.min(usage.bytesUsed / usage.quotaBytes, 1);
  const percent = Math.round(share * 100);
  const level = share >= QUOTA_FULL ? "full" : share >= QUOTA_WARN ? "warn" : "ok";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <p>
          <span className="font-medium">{formatBytes(usage.bytesUsed)}</span>
          <span className="text-muted-foreground"> of {formatBytes(usage.quotaBytes)} used</span>
        </p>
        <p className="text-muted-foreground tabular-nums">
          {usage.photoCount} {usage.photoCount === 1 ? "photo" : "photos"}
        </p>
      </div>
      <div
        role="meter"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% of ${formatBytes(usage.quotaBytes)} used`}
        data-level={level}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            level === "full" ? "bg-destructive" : level === "warn" ? "bg-amber-500" : "bg-primary",
          )}
          // A sliver stays visible for tiny amounts.
          style={{ width: `${usage.bytesUsed > 0 ? Math.max(percent, 1) : 0}%` }}
        />
      </div>
      {level === "full" && (
        <p className="text-sm text-destructive">Almost full — delete photos to make room.</p>
      )}
    </div>
  );
}
