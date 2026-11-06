import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { settleStep } from "./gridLayout";

/**
 * Tile size of the gallery grids (FR-GAL-8, like Google Photos): the justified rows' target
 * height in steps, smallest first. Phones (< 640 px) and wider screens have their own heights;
 * the step is shared. The largest phone step shows about two photos per row (user limit). Each
 * step must be a real change of size: on a phone 160 px laid out landscape photos as 240 px does,
 * two per row, so it only reshuffled the rows.
 */
export const PHONE_ROW_HEIGHTS = [56, 80, 112, 240] as const;
export const WIDE_ROW_HEIGHTS = [96, 136, 192, 384] as const;
/** The size before 8.33 (112 px phone, 192 px wider). */
export const DEFAULT_ZOOM = 2;
export const MAX_ZOOM = PHONE_ROW_HEIGHTS.length - 1;
export const ZOOM_STEPS = Array.from({ length: MAX_ZOOM + 1 }, (_, step) => step);

/** Fingers → size: the row height goes with the distance's ratio to this power, so a size takes
 * about twice the finger travel (at 1, one movement crossed all the sizes: user, "too fast"). */
const PINCH_SENSITIVITY = 0.5;
/** How far past the smallest / largest step the fingers may go (it springs back). */
const OVERSHOOT = 1.15;
/** Trackpad pinch: scale per wheel delta (e^(-delta × this)); a mouse notch counts as at most
 * `MAX_WHEEL_DELTA`, so Ctrl + a mouse wheel moves about one step per notch. */
const WHEEL_SCALE = 0.01;
const MAX_WHEEL_DELTA = 25;
/** A trackpad pinch has no "fingers lifted": it ends this long after the last wheel event. */
const WHEEL_END_MS = 180;
/** After release: the size eases from where the fingers left it to the nearest step. */
export const SETTLE_MS = 420;
const STORAGE_KEY = "photo-app.gridZoom";

export const rowHeightFor = (width: number, zoom: number) =>
  (width < 640 ? PHONE_ROW_HEIGHTS : WIDE_ROW_HEIGHTS)[clampZoom(zoom)]!;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom)));

/** The gesture's centre in viewport coordinates. */
export interface ZoomFocus {
  x: number;
  y: number;
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

/** Gentle at both ends: a fast start reads as a snap (user: "too fast"). */
const easeInOut = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;

export interface ZoomCallbacks {
  /** Row height of a step at the grid's current width. */
  heightOf: (zoom: number) => number;
  /** A gesture starts at `focus`; false ignores it (nothing to zoom, or still finishing one). */
  onStart: (focus: ZoomFocus) => boolean;
  /** Once per animation frame: show the grid at this continuous row height, `focus` held. */
  onFrame: (height: number, focus: ZoomFocus) => void;
  /** The gesture and its settle are over, on `step` (`changed`: not the step it started on). */
  onEnd: (step: number, changed: boolean) => void;
}

/**
 * Pinch on the grid to resize the tiles, continuously (FR-GAL-8): while the fingers move, the
 * grid is shown at the row height they ask for (the grid interpolates between the two nearest
 * steps' layouts, `onFrame`); on release the height eases to the nearest step, which then becomes
 * the grid's layout. A trackpad pinch (Ctrl + wheel) does the same. The browser's own page zoom
 * is kept off the grid meanwhile.
 */
export function useGridZoom(container: RefObject<HTMLElement | null>, callbacks: ZoomCallbacks) {
  const [zoom, setZoom] = useState(readZoom);
  const latest = useRef({ zoom, callbacks });
  // Read by the listeners; refreshed after each render.
  useLayoutEffect(() => {
    latest.current = { zoom, callbacks };
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    /** The gesture under way: the row height asked for and the fingers' centre. */
    let gesture: {
      height: number;
      focus: ZoomFocus;
      startHeight: number;
      startDistance: number;
    } | null = null;
    let settling = false;
    let frame = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;

    function start(focus: ZoomFocus, startDistance = 0) {
      if (settling) return false;
      const { zoom, callbacks } = latest.current;
      if (!callbacks.onStart(focus)) return false;
      const height = callbacks.heightOf(zoom);
      gesture = { height, focus, startHeight: height, startDistance };
      return true;
    }

    function moveTo(height: number, focus: ZoomFocus) {
      if (!gesture) return;
      const { zoom, callbacks } = latest.current;
      const { heightOf } = callbacks;
      // Fingers go one step per pinch; a trackpad's wheel events have no such single movement.
      const fingers = gesture.startDistance > 0;
      const low = fingers ? Math.max(0, zoom - 1) : 0;
      const high = fingers ? Math.min(MAX_ZOOM, zoom + 1) : MAX_ZOOM;
      gesture.height = Math.min(
        heightOf(high) * (high === MAX_ZOOM ? OVERSHOOT : 1),
        Math.max(heightOf(low) / (low === 0 ? OVERSHOOT : 1), height),
      );
      gesture.focus = focus;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (gesture) latest.current.callbacks.onFrame(gesture.height, gesture.focus);
      });
    }

    function end() {
      cancelAnimationFrame(frame);
      untrack();
      const ended = gesture;
      gesture = null;
      if (!ended) return;
      const { heightOf } = latest.current.callbacks;
      const next = settleStep(ended.height, ZOOM_STEPS.map(heightOf), latest.current.zoom);
      const from = ended.height;
      const to = heightOf(next);
      const finish = () => {
        settling = false;
        const { zoom, callbacks } = latest.current;
        callbacks.onFrame(to, ended.focus);
        const changed = next !== zoom;
        if (changed) {
          latest.current.zoom = next;
          writeZoom(next);
          setZoom(next);
        }
        callbacks.onEnd(next, changed);
      };
      if (reducedMotion()) return finish();
      settling = true;
      const startedAt = performance.now();
      // performance.now(), not the frame's timestamp: some engines (jsdom) use another origin.
      const step = () => {
        const progress = Math.min(1, (performance.now() - startedAt) / SETTLE_MS);
        if (progress >= 1) return finish();
        // On a log scale, as the fingers zoom.
        latest.current.callbacks.onFrame(from * (to / from) ** easeInOut(progress), ended.focus);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
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
      if (count(event) !== 2 || gesture) return;
      const { distance, focus } = fingers(event);
      if (distance > 0 && start(focus, distance)) track(event);
    }

    // A touch's events go to the element it started on, and only bubble from there while that
    // element is in the page. The pinch scrolls the page, the virtualizer then drops the row under
    // the fingers, and the grid would never hear them lift: listen on the elements themselves.
    let tracked: EventTarget[] = [];
    let touchIds: number[] = [];
    function track(event: TouchEvent) {
      const touches = Array.from(event.touches);
      touchIds = touches.map((touch) => touch.identifier);
      tracked = [...new Set(touches.map((touch) => touch.target))].filter(Boolean);
      for (const target of tracked) {
        target.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
        target.addEventListener("touchend", onTouchEnd as EventListener);
        target.addEventListener("touchcancel", onTouchEnd as EventListener);
      }
    }
    function untrack() {
      for (const target of tracked) {
        target.removeEventListener("touchmove", onTouchMove as EventListener);
        target.removeEventListener("touchend", onTouchEnd as EventListener);
        target.removeEventListener("touchcancel", onTouchEnd as EventListener);
      }
      tracked = [];
    }
    // Safety net: a new touch while neither of the gesture's fingers is down any more.
    function onAnyTouchStart(event: TouchEvent) {
      if (!gesture?.startDistance || !event.touches) return;
      const down = Array.from(event.touches).map((touch) => touch.identifier);
      if (!touchIds.some((id) => down.includes(id))) end();
    }

    // Not passive: only a blocking listener can keep the browser from zooming the page.
    function onTouchMove(event: TouchEvent) {
      if (count(event) !== 2 || !gesture || gesture.startDistance <= 0) return;
      if (event.cancelable) event.preventDefault();
      // The centre follows the fingers too: moving both scrolls the grid with them.
      const { distance, focus } = fingers(event);
      const ratio = distance / gesture.startDistance;
      moveTo(gesture.startHeight * ratio ** PINCH_SENSITIVITY, focus);
    }

    function onTouchEnd(event: TouchEvent) {
      if (count(event) < 2 && gesture?.startDistance) end();
    }

    function onWheel(event: WheelEvent) {
      // Browsers report a trackpad pinch as a wheel with Ctrl.
      if (!event.ctrlKey) return;
      event.preventDefault();
      const focus = { x: event.clientX, y: event.clientY };
      if (!gesture && !start(focus)) return;
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY));
      moveTo(gesture!.height * Math.exp(-delta * WHEEL_SCALE), focus);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(end, WHEEL_END_MS);
    }

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    element.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("touchstart", onAnyTouchStart, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      untrack();
      document.removeEventListener("touchstart", onAnyTouchStart, { capture: true });
      clearTimeout(wheelTimer);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
      element.removeEventListener("wheel", onWheel);
    };
  }, [container]);

  return { zoom };
}
