import { useEffect, useRef, useState, type RefObject } from "react";

/** How long a press has to be held. */
export const LONG_PRESS_MS = 400;
/** Moving further than this (px) before the press fires is a scroll, not a press. */
const MOVE_TOLERANCE = 10;
/** Dragging this close (px) to the top or bottom of the window scrolls the page. */
const EDGE_PX = 72;
/** Fastest auto-scroll, px per frame, at the very edge. */
const MAX_SCROLL_STEP = 18;
/** A click this soon (ms) after a drag ends belongs to that drag. */
const CLICK_AFTER_DRAG_MS = 400;

/** The attribute grid tiles carry, read by the gesture to find the tile under the finger. */
export const TILE_ATTRIBUTE = "data-photo-id";

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  photoId: string;
  timer: ReturnType<typeof setTimeout>;
  /** Set once the press has fired. */
  active?: {
    anchor: number;
    /** Selection when the drag began: the drag adds the range to it, or takes it out. */
    base: ReadonlySet<string>;
    adding: boolean;
    last: number;
    frame: number;
  };
}

/**
 * Press and slide to select (8.11), as in Google Photos: holding a tile for `LONG_PRESS_MS`
 * picks it (starting select mode), and sliding on, without lifting, picks every photo between it
 * and the one under the finger; near the top or bottom of the window the page scrolls along.
 * Starting on a picked photo in select mode unpicks the range instead. The page doesn't scroll
 * while dragging, and the click that ends a drag and Android's image/link menu are swallowed.
 *
 * Returns, while a drag is on, whether it began in select mode: tiles must keep the element they
 * had (link or select-mode button) until it's over, as a touch whose target leaves the DOM gets
 * no more events. Null when no drag is on.
 */
export function useDragSelect({
  container,
  photoIds,
  selected,
  onChange,
}: {
  container: RefObject<HTMLElement | null>;
  /** The grid's photos in order. */
  photoIds: readonly string[];
  /** Undefined outside select mode. */
  selected: ReadonlySet<string> | undefined;
  /** New selection; starts select mode. Undefined: no press-to-select. */
  onChange: ((selected: ReadonlySet<string>) => void) | undefined;
}) {
  const [startedInSelect, setStartedInSelect] = useState<boolean | null>(null);
  // Read by the listeners, which live as long as the grid.
  const latest = useRef({ photoIds, selected, onChange });
  useEffect(() => {
    latest.current = { photoIds, selected, onChange };
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let drag: Drag | null = null;
    let endedAt = -Infinity;

    const tileAt = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest(`[${TILE_ATTRIBUTE}]`)?.getAttribute(TILE_ATTRIBUTE);

    function select(index: number) {
      const active = drag?.active;
      const { photoIds, onChange } = latest.current;
      if (!active || index < 0 || !onChange) return;
      active.last = index;
      const next = new Set(active.base);
      const [from, to] = index < active.anchor ? [index, active.anchor] : [active.anchor, index];
      for (const photoId of photoIds.slice(from, to + 1)) {
        if (active.adding) next.add(photoId);
        else next.delete(photoId);
      }
      onChange(next);
    }

    function follow() {
      const active = drag?.active;
      if (!active) return;
      const over = tileAt(drag!.x, drag!.y);
      const index = over ? latest.current.photoIds.indexOf(over) : -1;
      if (index >= 0 && index !== active.last) select(index);
    }

    /** Scrolls while the finger is near an edge, and keeps picking what passes under it. */
    function autoScroll() {
      const active = drag?.active;
      if (!active) return;
      const { y } = drag!;
      const top = EDGE_PX - y;
      const bottom = y - (window.innerHeight - EDGE_PX);
      const step = top > 0 ? -top : bottom > 0 ? bottom : 0;
      if (step) {
        window.scrollBy(0, Math.round((step / EDGE_PX) * MAX_SCROLL_STEP));
        follow();
      }
      active.frame = requestAnimationFrame(autoScroll);
    }

    function begin() {
      const { photoIds, selected } = latest.current;
      if (!drag) return;
      const anchor = photoIds.indexOf(drag.photoId);
      if (anchor < 0) return end();
      const base = selected ?? new Set<string>();
      drag.active = { anchor, base, adding: !base.has(drag.photoId), last: -1, frame: 0 };
      navigator.vibrate?.(10);
      setStartedInSelect(selected !== undefined);
      select(anchor);
      drag.active.frame = requestAnimationFrame(autoScroll);
    }

    function end() {
      if (!drag) return;
      clearTimeout(drag.timer);
      if (drag.active) {
        cancelAnimationFrame(drag.active.frame);
        endedAt = performance.now();
        setStartedInSelect(null);
      }
      drag = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }

    function onDown(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0 || !latest.current.onChange) return;
      const photoId = (event.target as Element).closest(`[${TILE_ATTRIBUTE}]`);
      if (!photoId) return;
      end();
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        photoId: photoId.getAttribute(TILE_ATTRIBUTE)!,
        timer: setTimeout(begin, LONG_PRESS_MS),
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    }

    function onMove(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > MOVE_TOLERANCE) end();
        return;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      follow();
    }

    function onUp(event: PointerEvent) {
      if (drag && event.pointerId === drag.pointerId) end();
    }

    // Not passive, and registered for good: Chrome only lets a touchmove stop scrolling when a
    // blocking listener was there at touchstart.
    function onTouchMove(event: TouchEvent) {
      if (drag?.active && event.cancelable) event.preventDefault();
    }

    function onContextMenu(event: Event) {
      if (drag || performance.now() - endedAt < CLICK_AFTER_DRAG_MS) event.preventDefault();
    }

    // Capture: before the tile's own click (opening the viewer, or toggling in select mode).
    function onClick(event: MouseEvent) {
      if (performance.now() - endedAt >= CLICK_AFTER_DRAG_MS) return;
      endedAt = -Infinity;
      event.preventDefault();
      event.stopPropagation();
    }

    element.addEventListener("pointerdown", onDown);
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("contextmenu", onContextMenu);
    element.addEventListener("click", onClick, true);
    return () => {
      end();
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("contextmenu", onContextMenu);
      element.removeEventListener("click", onClick, true);
    };
  }, [container]);

  return startedInSelect;
}
