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

/** Fingers this much further apart (or this much closer, inverted) make one step. */
const PINCH_STEP_RATIO = 1.25;
/** Trackpad pinch (Ctrl + wheel) delta per step. */
const WHEEL_STEP = 60;
const STORAGE_KEY = "photo-app.gridZoom";

export const rowHeightFor = (width: number, zoom: number) =>
  (width < 640 ? PHONE_ROW_HEIGHTS : WIDE_ROW_HEIGHTS)[clampZoom(zoom)]!;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom)));

/** Where a step was made: the grid keeps whatever is under this point (viewport coordinates). */
export interface ZoomFocus {
  x: number;
  y: number;
}

// Per-viewer convenience only (it may come back empty or throw: private mode, blocked storage).
function readZoom(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return localStorage.getItem(STORAGE_KEY) === null ? DEFAULT_ZOOM : clampZoom(stored);
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

/**
 * Pinch on the grid to make tiles bigger (fingers apart) or smaller (together), one step per
 * `PINCH_STEP_RATIO`, several steps in one gesture; a trackpad pinch (Ctrl + wheel) does the same.
 * The browser's own page zoom is kept off the grid meanwhile. `onStep` gets the gesture's centre,
 * so the grid can keep the photo under the fingers in place.
 */
export function useGridZoom(
  container: RefObject<HTMLElement | null>,
  onStep?: (focus: ZoomFocus) => void,
) {
  const [zoom, setZoom] = useState(readZoom);
  const latest = useRef({ zoom, onStep });
  // Read by the listeners and `step`; refreshed after each render.
  useLayoutEffect(() => {
    latest.current = { zoom, onStep };
  });

  const step = useCallback((direction: 1 | -1, focus: ZoomFocus) => {
    const next = clampZoom(latest.current.zoom + direction);
    if (next === latest.current.zoom) return;
    latest.current.zoom = next;
    latest.current.onStep?.(focus);
    writeZoom(next);
    setZoom(next);
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let startDistance = 0;

    const fingers = (event: TouchEvent) => {
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      return {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        focus: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      };
    };

    // `touches` can be missing on synthetic events (other gestures' tests dispatch plain ones).
    const count = (event: TouchEvent) => event.touches?.length ?? 0;

    function onTouchStart(event: TouchEvent) {
      if (count(event) === 2) startDistance = fingers(event).distance;
    }

    // Not passive: only a blocking listener can keep the browser from zooming the page.
    function onTouchMove(event: TouchEvent) {
      if (count(event) !== 2 || startDistance <= 0) return;
      if (event.cancelable) event.preventDefault();
      const { distance, focus } = fingers(event);
      const ratio = distance / startDistance;
      if (ratio >= PINCH_STEP_RATIO || ratio <= 1 / PINCH_STEP_RATIO) {
        step(ratio > 1 ? 1 : -1, focus);
        startDistance = distance; // the next step counts from here
      }
    }

    function onTouchEnd(event: TouchEvent) {
      if (count(event) < 2) startDistance = 0;
    }

    let wheel = 0;
    function onWheel(event: WheelEvent) {
      // Browsers report a trackpad pinch as a wheel with Ctrl.
      if (!event.ctrlKey) return;
      event.preventDefault();
      wheel += event.deltaY;
      if (Math.abs(wheel) >= WHEEL_STEP) {
        step(wheel < 0 ? 1 : -1, { x: event.clientX, y: event.clientY });
        wheel = 0;
      }
    }

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
      element.removeEventListener("wheel", onWheel);
    };
  }, [container, step]);

  return zoom;
}
