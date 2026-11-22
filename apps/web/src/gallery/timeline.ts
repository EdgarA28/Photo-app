import type { PhotoSort } from "@photo-app/shared";

/** Helpers of the timeline scrubber (8.36, FR-GAL-9; `TimelineScrubber.tsx`). */
export interface TimelineMonth {
  /** `YYYY-MM`, local time. */
  month: string;
  count: number;
}

const shortMonth = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

/** "Oct 2026" for `2026-10`. */
export function monthLabel(month: string): string {
  const [year, mm] = month.split("-").map(Number);
  return shortMonth.format(new Date(year!, mm! - 1, 1));
}

/**
 * Where a jump to `month` starts the list (the API's `start`): newest first → before the next
 * month begins; oldest first → when the month begins. Local time, like the month headings.
 */
export function jumpStart(month: string, sort: PhotoSort): string {
  const [year, mm] = month.split("-").map(Number);
  const first = sort === "taken-desc" ? new Date(year!, mm!, 1) : new Date(year!, mm! - 1, 1);
  return first.toISOString();
}

/** Each month's place on the strip, 0–1, by the photos before it (in display order). */
export function monthPositions(months: readonly TimelineMonth[]): number[] {
  const total = months.reduce((sum, m) => sum + m.count, 0) || 1;
  let before = 0;
  return months.map((m) => {
    const at = before / total;
    before += m.count;
    return at;
  });
}

/** The month at `fraction` (0–1) of the strip. */
export function monthAt(months: readonly TimelineMonth[], fraction: number): number {
  const positions = monthPositions(months);
  let index = 0;
  for (let i = 0; i < positions.length; i++) if (positions[i]! <= fraction) index = i;
  return index;
}
