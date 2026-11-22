import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { monthAt, monthLabel, monthPositions, type TimelineMonth } from "./timeline";

/**
 * The timeline scrubber (8.36, FR-GAL-9; user request 2026-11-22, like Google Photos): a strip on
 * the right edge with the years and a dot per month, spaced by how many photos each month has.
 * Dragging it (or the arrow keys) picks a month: `onScrub(month, false)` while moving, `true` on
 * release. The handle shows where the page is (`current`). On a phone it shows while scrolling
 * and fades out after a moment; on a computer it stays.
 */
/** Labels closer than this (px) to the one above are left out. */
const LABEL_SPACING = 22;
/** Dots closer than this (px) to the one above, or to a label, are left out. */
const DOT_SPACING = 10;
/** Keys: how long after the last press the page jumps. */
const KEY_SETTLE_MS = 400;
/** How long the strip stays after the last scroll on a phone. */
const SHOW_MS = 1500;

export function TimelineScrubber({
  months,
  current,
  onScrub,
}: {
  /** In display order (the list's sort). */
  months: readonly TimelineMonth[];
  /** The month at the top of the screen. */
  current: string | null;
  onScrub: (month: string, final: boolean) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const positions = useMemo(() => monthPositions(months), [months]);

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Shown while the page scrolls (phones), hidden a moment after.
  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      setActive(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setActive(false), SHOW_MS);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, []);

  const { years, dots } = useMemo(() => {
    const years: { label: string; y: number }[] = [];
    const dots: number[] = [];
    let lastLabel = -Infinity;
    let lastDot = -Infinity;
    months.forEach((m, i) => {
      const y = positions[i]! * height;
      const year = m.month.slice(0, 4);
      // The first month's year too: the strip's top is the newest (or oldest) year.
      const newYear = i === 0 || year !== months[i - 1]!.month.slice(0, 4);
      if (newYear && y - lastLabel >= LABEL_SPACING) {
        years.push({ label: year, y });
        lastLabel = y;
        lastDot = y;
        return;
      }
      if (y - lastDot >= DOT_SPACING && y - lastLabel >= DOT_SPACING * 1.5) {
        dots.push(y);
        lastDot = y;
      }
    });
    return { years, dots };
  }, [months, positions, height]);

  const currentIndex = Math.max(
    0,
    months.findIndex((m) => m.month === current),
  );
  const shownIndex = dragging ?? currentIndex;
  const handleY = (positions[shownIndex] ?? 0) * height;
  const showLabel = dragging !== null || active;

  const indexAt = (clientY: number) => {
    const rect = track.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
    return monthAt(months, fraction);
  };
  const move = (index: number, final: boolean) => {
    setDragging(final ? null : index);
    onScrub(months[index]!.month, final);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    move(indexAt(event.clientY), false);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    const index = indexAt(event.clientY);
    if (index !== dragging) move(index, false);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    move(indexAt(event.clientY), true);
  };
  // Keys move the handle; the page follows once they stop (each jump reloads the list).
  const keyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(keyTimer.current), []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 12, PageUp: -12 };
    const from = dragging ?? currentIndex;
    let index: number | null = null;
    if (event.key in step) index = from + step[event.key]!;
    if (event.key === "Home") index = 0;
    if (event.key === "End") index = months.length - 1;
    if (index === null) return;
    event.preventDefault();
    const target = Math.min(months.length - 1, Math.max(0, index));
    move(target, false);
    window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => move(target, true), KEY_SETTLE_MS);
  };

  return (
    <div
      data-active={active || dragging !== null || undefined}
      className={cn(
        // Below the header, above the phone's floating tab bar; over the photos at the right edge.
        "fixed top-24 right-0 bottom-28 z-30 w-16 select-none md:top-20 md:bottom-6",
        "opacity-0 transition-opacity duration-300 md:opacity-100 data-active:opacity-100",
        "pointer-events-none md:pointer-events-auto data-active:pointer-events-auto",
      )}
    >
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={months.length - 1}
        aria-valuenow={shownIndex}
        aria-valuetext={months[shownIndex] ? monthLabel(months[shownIndex].month) : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragging(null)}
        onKeyDown={onKeyDown}
        onFocus={() => setActive(true)}
        className="relative h-full cursor-ns-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {years.map(({ label, y }) => (
          <span
            key={label}
            // Readable over the photos it floats on.
            className="absolute right-2 -translate-y-1/2 rounded bg-background/85 px-1 text-xs text-muted-foreground"
            style={{ top: y }}
          >
            {label}
          </span>
        ))}
        {dots.map((y) => (
          <span
            key={y}
            aria-hidden
            className="absolute right-5 size-1 -translate-y-1/2 rounded-full bg-muted-foreground/50"
            style={{ top: y }}
          />
        ))}
        {/* The handle: where the page is, or where the finger is while dragging. */}
        <div
          className="absolute right-0 flex -translate-y-1/2 items-center gap-1"
          style={{ top: handleY }}
        >
          {showLabel && months[shownIndex] && (
            <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium whitespace-nowrap text-foreground shadow ring-1 ring-border">
              {monthLabel(months[shownIndex].month)}
            </span>
          )}
          <span aria-hidden className="h-0.5 w-6 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}
