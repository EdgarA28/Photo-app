import type { Photo } from "@photo-app/shared";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  bracket,
  fadeIn,
  FADE_TO,
  gridItems,
  place,
  tileAt,
  type GridItem,
  type Placement,
} from "./gridLayout";
import { ZOOM_STEPS, type ZoomCallbacks, type ZoomFocus } from "./useGridZoom";

/** Set on the grid while the layer shows: its real rows are hidden then. */
export const PINCHING_ATTRIBUTE = "data-pinching";
/** Tiles rendered beyond the viewport, in viewport heights (so most frames add none). */
const RENDER_MARGIN = 0.75;
/** How long the hand-over waits for the real rows' images (a slow one mustn't hold the layer). */
const HANDOVER_WAIT_MS = 400;

/** One step's grid, as rendered: the tiles by index into `photos`, and where each is. */
export interface PinchStep {
  step: number;
  placement: Placement;
  tiles: number[];
}

/** What the layer renders: the one or two steps the size is between. */
export interface PinchLayerState {
  photos: readonly Photo[];
  headings: string[];
  steps: PinchStep[];
}

interface Session {
  photos: readonly Photo[];
  /** Every step's layout of `photos`. */
  placements: Placement[];
  heights: number[];
  headings: string[];
  /** The photo under the fingers and the point on it they hold (fractions of its size). */
  anchor: { index: number; u: number; v: number };
  /** The grid's top in document coordinates, and the page below it (they bound the scroll). */
  top: number;
  below: number;
  last: { height: number; focus: ZoomFocus };
  /** Tiles rendered per step so far. */
  rendered: Map<number, Set<number>>;
  /** The steps rendered now. */
  shown: number[];
  /** Set once the gesture settled: the step it ended on. */
  ending: { step: number } | null;
  handedOver: boolean;
}

interface PinchLayerOptions {
  grid: RefObject<HTMLElement | null>;
  photos: readonly Photo[];
  width: number;
  months: boolean;
  heightOf: (step: number) => number;
  /** The grid's current layout and step (the gesture starts from it). */
  current: () => { items: readonly GridItem[]; zoom: number };
}

/** Resolves when the real rows' images on screen are decoded (or `HANDOVER_WAIT_MS` have passed). */
function imagesReady(grid: HTMLElement) {
  const images = Array.from(
    grid.querySelectorAll<HTMLImageElement>(":scope > :not([data-pinch-layer]) img"),
  ).filter((image) => {
    const box = image.getBoundingClientRect();
    return box.bottom >= 0 && box.top <= window.innerHeight;
  });
  return Promise.race([
    // `decode` rejects for an image that failed: its tile shows the placeholder anyway.
    Promise.allSettled(images.map((image) => image.decode?.())),
    new Promise((resolve) => setTimeout(resolve, HANDOVER_WAIT_MS)),
  ]);
}

/** Tiles of a layout with any part between `top` and `bottom` (the layout's coordinates). */
function tilesBetween(placement: Placement, top: number, bottom: number) {
  const found: number[] = [];
  for (let i = 0; i < placement.y.length; i++) {
    if (placement.y[i]! + placement.h[i]! > top && placement.y[i]! < bottom) found.push(i);
  }
  return found;
}

/**
 * The continuous pinch (FR-GAL-8), as in Google Photos: while the fingers move, the smaller of the
 * two steps the size is between shows as a whole grid, scaled up around the photo under the fingers
 * and kept flush with the screen's sides, so it always covers the width (justified rows can't be
 * interpolated tile by tile: they break differently at each size). Close to the next step the larger
 * dissolves in over it, scaled so that photo has the same size and place in both. The page scrolls
 * to hold it under the fingers, as far as it can. Each grid reaches scale 1 at its own step, so a
 * step's grid is exactly the real one: on release, once the size has settled, the real grid takes
 * over and the layer goes. Per frame only the two layers' transforms change.
 */
export function usePinchLayer({
  grid,
  photos,
  width,
  months,
  heightOf,
  current,
}: PinchLayerOptions) {
  const [layer, setLayer] = useState<PinchLayerState | null>(null);
  const session = useRef<Session | null>(null);
  const stepNodes = useRef(new Map<number, HTMLElement>());

  function render(s: Session) {
    setLayer({
      photos: s.photos,
      headings: s.headings,
      steps: s.shown.map((step) => ({
        step,
        placement: s.placements[step]!,
        tiles: [...(s.rendered.get(step) ?? [])],
      })),
    });
  }

  /** Shows the grid at a row height, the anchor under `focus` (one animation frame). */
  function draw(height: number, focus: ZoomFocus) {
    const s = session.current;
    const element = grid.current;
    if (!s || !element) return;
    s.last = { height, focus };
    const { a: from, b: to, t, scale } = bracket(height, s.heights);
    const a = s.placements[from]!;
    const b = s.placements[to]!;
    const { index, u, v } = s.anchor;
    const point = (p: Placement) => ({
      x: p.x[index]! + u * p.w[index]!,
      y: p.y[index]! + v * p.h[index]!,
      h: p.h[index]!,
    });
    const [pa, pb] = [point(a), point(b)];
    // The anchor's size on screen, and each grid's scale for it (1 at its own step).
    const size = pa.h * (pb.h / pa.h) ** t * scale;
    const [scaleA, scaleB] = [size / pa.h, size / pb.h];
    const originA = focus.y - scaleA * pa.y;
    const originB = focus.y - scaleB * pb.y;
    const origin = originA + (originB - originA) * t;

    // The page scrolls so the anchor stays under the fingers, as far as it can: not above the
    // page's top, nor so far that the grid's end comes up past the viewport's bottom.
    const viewport = window.innerHeight;
    const total = a.height + (b.height - a.height) * t;
    const scroll = Math.max(0, Math.min(s.top - origin, s.top + total + s.below - viewport));
    // Room for it while the layout is taller than the grid's real one (zooming in).
    element.style.setProperty(
      "min-height",
      `${Math.max(0, scroll + viewport - s.top - s.below)}px`,
    );
    if (Math.abs(scroll - window.scrollY) > 0.5) {
      window.scrollTo({ top: scroll, behavior: "instant" });
    }
    const gridTop = s.top - window.scrollY;
    // What the page couldn't scroll moves the grids instead.
    const shift = gridTop - origin;
    const anchorX = pa.x + (pb.x - pa.x) * t;
    const gridWidth = element.clientWidth;

    const shown = from === to ? [from] : [from, to];
    let missing = shown.join() !== s.shown.join();
    const place = (step: number, p: { x: number }, zoomed: number, top: number, alpha: number) => {
      // Horizontally the anchor goes from its place in one grid to its place in the other, as far
      // as the grid stays flush with the sides: scaled up it covers the width, below 1 it stays
      // inside it.
      const slack = gridWidth - zoomed * gridWidth;
      const x = Math.min(Math.max(0, slack), Math.max(Math.min(0, slack), anchorX - zoomed * p.x));
      const node = stepNodes.current.get(step);
      if (node) {
        node.style.transform = `translate3d(${x}px, ${top - gridTop}px, 0) scale(${zoomed})`;
        node.style.opacity = String(alpha);
      }
      // What the viewport shows of this grid, in its own coordinates.
      const screen = (y: number) => (y - top) / zoomed;
      const near = viewport * (RENDER_MARGIN / 3 / zoomed);
      const rendered = s.rendered.get(step) ?? new Set<number>();
      s.rendered.set(step, rendered);
      const placement = s.placements[step]!;
      if (
        tilesBetween(placement, screen(0) - near, screen(viewport) + near).some(
          (i) => !rendered.has(i),
        )
      ) {
        const far = near * 3;
        for (const i of tilesBetween(placement, screen(0) - far, screen(viewport) + far))
          rendered.add(i);
        missing = true;
      }
    };
    place(
      from,
      pa,
      scaleA,
      originA + shift,
      from === to ? 1 : Math.min(1, (1 - t) / (1 - FADE_TO)),
    );
    if (from !== to) place(to, pb, scaleB, originB + shift, fadeIn(t));

    if (missing) {
      s.shown = shown;
      render(s);
    }
  }

  /** The real grid has the final layout (where the layer shows it): remove the layer once the
   * virtualizer has rendered its rows there. */
  function finish() {
    const s = session.current;
    const element = grid.current;
    if (!s || !element || s.handedOver) return;
    s.handedOver = true;
    draw(s.last.height, s.last.focus);
    element.style.removeProperty("min-height");
    const twoFrames = (then: () => void) =>
      requestAnimationFrame(() => requestAnimationFrame(then));
    // The scroll events reach the virtualizer, which renders the rows there. Their tiles are mostly
    // new elements: until the images are decoded they would flash their placeholders, so the
    // layer stays over them until then; the rows paint under it once before it goes.
    twoFrames(() => {
      void imagesReady(element).then(() => {
        if (session.current !== s) return;
        element.removeAttribute(PINCHING_ATTRIBUTE);
        twoFrames(() => {
          if (session.current !== s) return;
          session.current = null;
          setLayer(null);
        });
      });
    });
  }

  const callbacks: Omit<ZoomCallbacks, "heightOf"> = {
    onStart: (focus) => {
      const element = grid.current;
      if (!element || photos.length === 0 || width <= 0 || session.current) return false;
      const box = element.getBoundingClientRect();
      const indexOf = new Map(photos.map((photo, i) => [photo.photoId, i]));
      const heights = ZOOM_STEPS.map(heightOf);
      const { items, zoom } = current();
      const placements = ZOOM_STEPS.map((step) =>
        place(step === zoom ? items : gridItems(photos, width, heights[step]!, months), indexOf),
      );
      const here = placements[zoom]!;
      const x = focus.x - box.left;
      const y = focus.y - box.top;
      const index = Math.max(0, tileAt(here, x, y));
      const s: Session = {
        photos,
        placements,
        heights,
        headings: items.flatMap((item) => (item.kind === "month" ? [item.label] : [])),
        // Not clamped to the tile: on a heading or a gap, that point is held instead.
        anchor: {
          index,
          u: (x - here.x[index]!) / (here.w[index]! || 1),
          v: (y - here.y[index]!) / (here.h[index]! || 1),
        },
        top: box.top + window.scrollY,
        below: Math.max(0, document.documentElement.scrollHeight - (box.bottom + window.scrollY)),
        last: { height: heights[zoom]!, focus },
        rendered: new Map(),
        shown: [zoom],
        ending: null,
        handedOver: false,
      };
      const margin = window.innerHeight * RENDER_MARGIN;
      s.rendered.set(
        zoom,
        new Set(tilesBetween(here, -box.top - margin, window.innerHeight - box.top + margin)),
      );
      session.current = s;
      render(s);
      return true;
    },
    onFrame: (height, focus) => {
      // The real rows hide once the layer moves (its images have had the first frame to decode).
      grid.current?.setAttribute(PINCHING_ATTRIBUTE, "");
      draw(height, focus);
    },
    onEnd: (step, changed) => {
      const s = session.current;
      if (!s) return;
      s.ending = { step };
      // A new step re-lays the grid first (then `onLayout`); the same one is already there.
      if (!changed) finish();
    },
  };

  // After a render that added a step or tiles: place them.
  useLayoutEffect(() => {
    const s = session.current;
    if (s && !s.handedOver) draw(s.last.height, s.last.focus);
    // Only on `layer`: `draw` reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer]);

  /** The grid calls this after each re-layout (before paint): once it is the gesture's new
   * step (not, say, a page of photos that came in meanwhile), hand over to it. */
  const onLayout = (zoom: number) => {
    if (session.current?.ending?.step === zoom) finish();
  };

  const stepRef = (step: number) => (node: HTMLElement | null) => {
    if (node) stepNodes.current.set(step, node);
    else stepNodes.current.delete(step);
  };

  return { layer, stepRef, callbacks, onLayout };
}
