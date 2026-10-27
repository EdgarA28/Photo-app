import type { Photo } from "@photo-app/shared";
import { LoaderCircle } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { Api } from "@/api/api";
import { cn } from "@/lib/utils";
import { useOriginal } from "./useOriginal";
import { clamp, fitted, maxScale, NO_ZOOM, zoomAt, type Size, type Zoom } from "./zoomMath";

/** Scale a double tap/click or the + key zooms to. */
const DOUBLE_TAP_SCALE = 2.5;
const KEY_STEP = 1.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 10;
/** Wheel/trackpad sensitivity; a trackpad pinch arrives as a wheel with ctrlKey and small deltas. */
const WHEEL_SPEED = 0.002;
const PINCH_WHEEL_SPEED = 0.01;

interface Point {
  x: number;
  y: number;
}

/**
 * The viewer's photo with zoom (§12.3): pinch, double tap and drag on touch; wheel or trackpad
 * pinch, double click, drag and + / - / 0 on a computer. At normal size gestures belong to the
 * page (swipe to the next photo); zoomed in, or during a pinch, they are taken here. Zoomed past
 * the preview's detail, the original loads and replaces it (`useOriginal`).
 */
export function ZoomableImage({
  api,
  photo,
  album,
  src,
  keys,
  onError,
}: {
  api: Api;
  photo: Photo;
  album: string | undefined;
  /** The preview. */
  src: string;
  /** Whether + / - / 0 work (not while a dialog is open). */
  keys: boolean;
  onError: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(boxRef);
  const natural = { width: photo.width ?? 0, height: photo.height ?? 0 };
  const fit = fitted(box, natural);
  const max = maxScale(fit, natural);
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const apply = (next: Zoom) => setZoom(clamp(next, box, fit, max));

  // The preview's own pixel width, once loaded; the original is worth it beyond that.
  const [previewWidth, setPreviewWidth] = useState(0);
  const shownWidth = fit.width * zoom.scale * (window.devicePixelRatio || 1);
  const wantOriginal =
    previewWidth > 0 && natural.width > previewWidth && shownWidth > previewWidth * 1.05;
  const original = useOriginal(api, photo, album, wantOriginal);

  // Box-centred coordinates of a client point.
  const local = (clientX: number, clientY: number): Point => {
    const rect = boxRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  const toggleAt = (at: Point) =>
    apply(zoom.scale > 1 ? NO_ZOOM : zoomAt(zoom, DOUBLE_TAP_SCALE, at));

  // ---- pointers: pan with one, pinch with two ----
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    owned: boolean;
    start: Zoom;
    from: Point;
    distance: number;
    tap: { at: Point; time: number; moved: boolean } | null;
  } | null>(null);
  const lastTap = useRef<{ at: Point; time: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const at = local(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, at);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const points = [...pointers.current.values()];
    if (points.length === 1) {
      gesture.current = {
        owned: zoom.scale > 1,
        start: zoom,
        from: at,
        distance: 0,
        tap: { at, time: event.timeStamp, moved: false },
      };
    } else if (points.length === 2) {
      gesture.current = {
        owned: true,
        start: zoom,
        from: midpoint(points),
        distance: distance(points),
        tap: null,
      };
    }
    if (gesture.current?.owned) event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    const at = local(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, at);
    const g = gesture.current;
    const points = [...pointers.current.values()];
    if (g.tap && Math.hypot(at.x - g.tap.at.x, at.y - g.tap.at.y) > TAP_SLOP_PX) g.tap.moved = true;
    if (points.length >= 2 && g.distance > 0) {
      // Pinch: the photo point under the starting midpoint follows the fingers' midpoint.
      const scale = g.start.scale * (distance(points) / g.distance);
      const moved = zoomAt(g.start, scale, g.from);
      const mid = midpoint(points);
      apply({ ...moved, x: moved.x + mid.x - g.from.x, y: moved.y + mid.y - g.from.y });
    } else if (points.length === 1 && g.owned) {
      apply({ ...g.start, x: g.start.x + at.x - g.from.x, y: g.start.y + at.y - g.from.y });
    }
    if (g.owned) event.stopPropagation();
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const g = gesture.current;
    if (g?.owned) event.stopPropagation();
    if (pointers.current.size > 0) {
      // One finger of a pinch lifted: carry on panning with the other.
      const [rest] = [...pointers.current.values()];
      gesture.current = { owned: true, start: zoom, from: rest!, distance: 0, tap: null };
      return;
    }
    gesture.current = null;
    const up = local(event.clientX, event.clientY);
    if (event.type !== "pointerup" || !g?.tap || g.tap.moved) return;
    if (Math.hypot(up.x - g.tap.at.x, up.y - g.tap.at.y) > TAP_SLOP_PX) return;
    if (event.timeStamp - g.tap.time > DOUBLE_TAP_MS) return;
    // A tap: the second one close to the first, soon after, toggles the zoom (touch; a mouse
    // gets onDoubleClick instead).
    const previous = lastTap.current;
    if (
      event.pointerType !== "mouse" &&
      previous &&
      event.timeStamp - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(g.tap.at.x - previous.at.x, g.tap.at.y - previous.at.y) < TAP_SLOP_PX * 3
    ) {
      lastTap.current = null;
      toggleAt(g.tap.at);
    } else {
      lastTap.current = { at: g.tap.at, time: event.timeStamp };
    }
  };

  // ---- wheel (non-passive, so the page doesn't scroll or zoom instead) and keys ----
  useEffect(() => {
    const element = boxRef.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const speed = event.ctrlKey ? PINCH_WHEEL_SPEED : WHEEL_SPEED;
      const scale = Math.min(max, Math.max(1, zoom.scale * Math.exp(-event.deltaY * speed)));
      apply(zoomAt(zoom, scale, local(event.clientX, event.clientY)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  useEffect(() => {
    if (!keys) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const center = { x: 0, y: 0 };
      if (event.key === "+" || event.key === "=")
        apply(zoomAt(zoom, zoom.scale * KEY_STEP, center));
      else if (event.key === "-") apply(zoomAt(zoom, zoom.scale / KEY_STEP, center));
      else if (event.key === "0") apply(NO_ZOOM);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const zoomed = zoom.scale > 1;
  return (
    <div
      ref={boxRef}
      data-testid="zoom-box"
      data-scale={zoom.scale.toFixed(2)}
      className={cn(
        "relative size-full touch-none overflow-hidden",
        zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={(event) => toggleAt(local(event.clientX, event.clientY))}
    >
      <img
        src={original.status === "ready" ? original.url : src}
        alt={photo.fileName}
        width={photo.width ?? undefined}
        height={photo.height ?? undefined}
        draggable={false}
        onError={original.status === "ready" ? undefined : onError}
        onLoad={(event) => {
          if (original.status !== "ready") setPreviewWidth(event.currentTarget.naturalWidth);
        }}
        // Laid out at the zoomed size and only moved with translate, not scaled: a scaled
        // (composited) image is drawn at its unzoomed size and stretched, which blurs it and
        // shows the GPU tile seams as lines. Before the box is measured, it simply fits.
        className={fit.width ? "absolute top-1/2 left-1/2 max-w-none" : "size-full object-contain"}
        style={
          fit.width
            ? {
                width: fit.width * zoom.scale,
                height: fit.height * zoom.scale,
                transform: `translate(-50%, -50%) translate(${zoom.x}px, ${zoom.y}px)`,
              }
            : undefined
        }
      />
      {original.status === "loading" && (
        <span
          role="status"
          className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white"
        >
          <LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />
          Loading full resolution
        </span>
      )}
    </div>
  );
}

const midpoint = ([a, b]: Point[]): Point => ({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 });
const distance = ([a, b]: Point[]) => Math.hypot(a!.x - b!.x, a!.y - b!.y);

function useBoxSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setSize((prev) =>
        prev.width === element.clientWidth && prev.height === element.clientHeight
          ? prev
          : { width: element.clientWidth, height: element.clientHeight },
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
