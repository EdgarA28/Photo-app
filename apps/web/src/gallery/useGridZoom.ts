import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Tile size of the gallery grids (FR-GAL-8, like Google Photos): the justified rows' target
 * height in steps, smallest first. Phones (< 640 px) and wider screens have their own heights;
 * the step is shared. The largest phone step shows about one photo per row.
 */
export const PHONE_ROW_HEIGHTS = [56, 80, 112, 160, 240, 360] as const;
export const WIDE_ROW_HEIGHTS = [96, 136, 192, 272, 384, 520] as const;
/** The size before 8.33 (112 px phone, 192 px wider). */
export const DEFAULT_ZOOM = 2;
export const MAX_ZOOM = PHONE_ROW_HEIGHTS.length - 1;

/** How far past the smallest / largest step the live scale may go (it springs back). */
const OVERSHOOT = 1.15;
/** Trackpad pinch: scale per wheel delta (e^(-delta × this)); a mouse notch counts as at most
 * `MAX_WHEEL_DELTA`, so Ctrl + a mouse wheel moves about one step per notch. */
const WHEEL_SCALE = 0.01;
const MAX_WHEEL_DELTA = 25;
/** A trackpad pinch has no "fingers lifted": it ends this long after the last wheel event. */
const WHEEL_END_MS = 180;
/** The settle after release: the new layout eases from the size shown to its own. */
export const SETTLE_MS = 220;
const SETTLE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const STORAGE_KEY = "photo-app.gridZoom";

export const rowHeightFor = (width: number, zoom: number) =>
  (width < 640 ? PHONE_ROW_HEIGHTS : WIDE_ROW_HEIGHTS)[clampZoom(zoom)]!;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom)));

/** The gesture's centre in viewport coordinates. */
export interface ZoomFocus {
  x: number;
  y: number;
}

/** The step whose row height is nearest (on a log scale, as zoom is felt) to `height`. */
export function nearestZoom(height: number, heightOf: (zoom: number) => number): number {
  let best = 0;
  for (let zoom = 1; zoom <= MAX_ZOOM; zoom++) {
    if (Math.abs(Math.log(heightOf(zoom) / height)) < Math.abs(Math.log(heightOf(best) / height)))
      best = zoom;
  }
  return best;
}

// Per-viewer convenience only (it may come back empty or throw: private mode, blocked storage).
function readZoom(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_ZOOM : clampZoom(Number(stored));
  } catch {
    return DEFAULT_ZOOM;
  }
}

function writeZoom(zoom: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(zoom));
  } catch {
    // Not remembered; the step still applies.
  }
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface ZoomCallbacks {
  /** Row height of a step at the grid's current width. */
  heightOf: (zoom: number) => number;
  /** A gesture starts at `focus`: the grid notes what is under it (before any transform). */
  onStart?: (focus: ZoomFocus) => void;
  /** The gesture ended on another step: the grid keeps what it noted in place, then calls
   * `settle()` once it has re-laid out and scrolled. */
  onCommit?: () => void;
}

/**
 * Pinch on the grid to resize the tiles, continuously (FR-GAL-8): while the fingers move, the
 * grid itself is scaled around the gesture's centre (a CSS transform, no re-layout per frame);
 * on release it snaps to the nearest step: the new layout appears at the size that was shown and
 * eases to its own (`settle`), or eases back when the step didn't change. A trackpad pinch (Ctrl +
 * wheel) does the same. The browser's own page zoom is kept off the grid meanwhile.
 *
 * Returns the step, whether a gesture or its settle is under way (the grid renders more rows
 * then, as scaling down shows more), and `settle`.
 */
export function useGridZoom(container: RefObject<HTMLElement | null>, callbacks: ZoomCallbacks) {
  const [zoom, setZoom] = useState(readZoom);
  const [pinching, setPinching] = useState(false);
  const latest = useRef({ zoom, callbacks });
  // Read by the listeners; refreshed after each render.
  useLayoutEffect(() => {
    latest.current = { zoom, callbacks };
  });
  /** Set when a gesture committed a new step: what `settle` animates from. */
  const pending = useRef<{ scale: number; focus: ZoomFocus } | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** Eases the grid from a scale to its real size (set by the effect, which owns the element). */
  const ease = useRef<((scale: number, focus: ZoomFocus) => void) | null>(null);

  /** Called by the grid after it re-laid out (and re-anchored) for a committed step. */
  const settle = useCallback(() => {
    const from = pending.current;
    pending.current = null;
    if (from) ease.current?.(from.scale, from.focus);
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    /** The gesture under way: its centre and origin at the start, the live scale. */
    let gesture: { focus: ZoomFocus; origin: string; scale: number; startDistance: number } | null =
      null;
    let frame = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;

    ease.current = (scale, focus) => {
      clearTimeout(settleTimer.current);
      const done = () => {
        element.style.transition = "";
        element.style.transform = "";
        element.style.transformOrigin = "";
        element.style.willChange = "";
        setPinching(false);
      };
      if (reducedMotion() || Math.abs(scale - 1) < 0.001) return done();
      element.style.transition = "none";
      element.style.transform = "";
      const box = element.getBoundingClientRect();
      element.style.transformOrigin = `${focus.x - box.left}px ${focus.y - box.top}px`;
      element.style.transform = `scale(${scale})`;
      void element.offsetWidth; // start the transition from this scale
      element.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASING}`;
      element.style.transform = "scale(1)";
      // A timer rather than `transitionend`, which doesn't come if the transition is skipped.
      settleTimer.current = setTimeout(done, SETTLE_MS + 30);
    };

    function start(focus: ZoomFocus, startDistance = 0) {
      clearTimeout(settleTimer.current);
      element!.style.transition = "none";
      element!.style.transform = "";
      latest.current.callbacks.onStart?.(focus);
      const box = element!.getBoundingClientRect();
      gesture = {
        focus,
        origin: `${focus.x - box.left}px ${focus.y - box.top}px`,
        scale: 1,
        startDistance,
      };
      element!.style.transformOrigin = gesture.origin;
      element!.style.willChange = "transform";
      setPinching(true);
    }

    function scaleTo(raw: number) {
      if (!gesture) return;
      const { zoom, callbacks } = latest.current;
      const current = callbacks.heightOf(zoom);
      const min = callbacks.heightOf(0) / current / OVERSHOOT;
      const max = (callbacks.heightOf(MAX_ZOOM) / current) * OVERSHOOT;
      gesture.scale = Math.min(max, Math.max(min, raw));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (gesture) element!.style.transform = `scale(${gesture.scale})`;
      });
    }

    function end() {
      cancelAnimationFrame(frame);
      const ended = gesture;
      gesture = null;
      if (!ended) return;
      const { zoom, callbacks } = latest.current;
      const current = callbacks.heightOf(zoom);
      const next = nearestZoom(current * ended.scale, callbacks.heightOf);
      if (next === zoom) {
        // Back to the size it had.
        element!.style.transform = `scale(${ended.scale})`;
        ease.current?.(ended.scale, ended.focus);
        return;
      }
      // The new layout will be `heightOf(next) / current` times this one: it starts at the
      // scale shown, relative to its own size.
      pending.current = {
        scale: ended.scale / (callbacks.heightOf(next) / current),
        focus: ended.focus,
      };
      latest.current.zoom = next;
      callbacks.onCommit?.();
      writeZoom(next);
      setZoom(next);
    }

    // `touches` can be missing on synthetic events (other gestures' tests dispatch plain ones).
    const count = (event: TouchEvent) => event.touches?.length ?? 0;
    const fingers = (event: TouchEvent) => {
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      return {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        focus: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      };
    };

    function onTouchStart(event: TouchEvent) {
      if (count(event) !== 2) return;
      const { distance, focus } = fingers(event);
      if (distance > 0) start(focus, distance);
    }

    // Not passive: only a blocking listener can keep the browser from zooming the page.
    function onTouchMove(event: TouchEvent) {
      if (count(event) !== 2 || !gesture || gesture.startDistance <= 0) return;
      if (event.cancelable) event.preventDefault();
      scaleTo(fingers(event).distance / gesture.startDistance);
    }

    function onTouchEnd(event: TouchEvent) {
      if (count(event) < 2 && gesture?.startDistance) end();
    }

    function onWheel(event: WheelEvent) {
      // Browsers report a trackpad pinch as a wheel with Ctrl.
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (!gesture) start({ x: event.clientX, y: event.clientY });
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY));
      scaleTo(gesture!.scale * Math.exp(-delta * WHEEL_SCALE));
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(end, WHEEL_END_MS);
    }

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(wheelTimer);
      ease.current = null;
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
      element.removeEventListener("wheel", onWheel);
    };
  }, [container]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  return { zoom, pinching, settle };
}
