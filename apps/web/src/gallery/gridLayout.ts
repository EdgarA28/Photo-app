import type { Photo } from "@photo-app/shared";
import { justifyRows, type Row } from "./justify";
import { monthSections } from "./months";

/** Below this grid width the tiles use the phone sizes and hairline gaps. */
const PHONE_WIDTH = 640;
/** Between tiles: as thin as Google Photos' on a phone (measured there, about 1.5 px). */
const PHONE_GAP = 1.5;
const WIDE_GAP = 4;
/** Height of a month heading above its rows, the gap after the previous row included. */
export const MONTH_HEADING_HEIGHT = 44;

/**
 * Tile size of the gallery grids (FR-GAL-8, like Google Photos): the justified rows' target
 * height in steps, smallest first. Wider screens have fixed heights; a phone has two, then its
 * larger steps are a number of photos per row (`PHONE_PER_ROW`). The step is shared. Each step
 * must be a real change of size: by height alone, landscape photos stay two per row from 160 to
 * 240 px, so a step there only reshuffled the rows.
 */
const PHONE_ROW_HEIGHTS = [56, 72] as const;
const PHONE_PER_ROW = [4, 3, 2] as const;
const WIDE_ROW_HEIGHTS = [96, 136, 192, 272, 384] as const;
/** The size a new device starts on. */
export const DEFAULT_ZOOM = 2;
export const MAX_ZOOM = WIDE_ROW_HEIGHTS.length - 1;
export const ZOOM_STEPS = Array.from({ length: MAX_ZOOM + 1 }, (_, step) => step);

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom)));

const isPhone = (width: number) => width < PHONE_WIDTH;
/** The phone's limit on a row at a step, if it has one. */
const perRow = (width: number, step: number) =>
  isPhone(width) ? PHONE_PER_ROW[clampZoom(step) - PHONE_ROW_HEIGHTS.length] : undefined;

/**
 * Row height of a step at a grid width. A photos-per-row step aims a little below the width over
 * that number, so four 4:3 photos fit (the limit keeps portrait photos from fitting more, and only
 * a panorama fills a two-per-row row alone). No fixed height does this: two portrait photos need
 * 273 px on a 412 px phone, where 3:2 landscape ones would then go alone.
 */
export function rowHeightFor(width: number, step: number) {
  const count = perRow(width, step);
  if (count) return Math.round(width / (count + 0.1));
  return (isPhone(width) ? PHONE_ROW_HEIGHTS : WIDE_ROW_HEIGHTS)[clampZoom(step)]!;
}

// Pending photos have no dimensions yet (they come from the thumbnail Lambda): square until ready.
const aspectOf = (photo: Photo) => (photo.width && photo.height ? photo.width / photo.height : 1);

/** What the virtualizer lays out: a month heading or a row of tiles. */
export type GridItem =
  | { kind: "month"; label: string; height: number }
  | { kind: "row"; row: Row<Photo>; height: number; gap: number };

/** The grid's justified rows (§12.3) at a size step, under month headings if asked. */
export function gridItems(
  photos: readonly Photo[],
  width: number,
  step: number,
  months: boolean,
): GridItem[] {
  if (width <= 0) return [];
  const gap = isPhone(width) ? PHONE_GAP : WIDE_GAP;
  // Row height to aim for; full rows end up a little taller or shorter to fill the width.
  const options = {
    containerWidth: width,
    targetHeight: rowHeightFor(width, step),
    gap,
    maxPerRow: perRow(width, step),
  };
  const rowsOf = (list: readonly Photo[]): GridItem[] =>
    justifyRows(list, aspectOf, options).map((row) => ({
      kind: "row",
      row,
      height: row.height + gap,
      gap,
    }));
  if (!months) return rowsOf(photos);
  // Each month gets its own rows, so a row never mixes months (§12.3).
  return monthSections(photos, (photo) => photo.takenAt).flatMap(({ label, items }) => [
    { kind: "month", label, height: MONTH_HEADING_HEIGHT } as const,
    ...rowsOf(items),
  ]);
}

/**
 * Where every tile and heading of a layout is, in grid coordinates: tile `i` (by `indexOf`) at
 * `x[i], y[i]`, `w[i] × h[i]`; heading `j` (in order) at `headings[j]`. The pinch interpolates
 * between two of these (FR-GAL-8).
 */
export interface Placement {
  x: Float64Array;
  y: Float64Array;
  w: Float64Array;
  h: Float64Array;
  headings: number[];
  height: number;
}

export function place(items: readonly GridItem[], indexOf: ReadonlyMap<string, number>): Placement {
  const n = indexOf.size;
  const placement: Placement = {
    x: new Float64Array(n),
    y: new Float64Array(n),
    w: new Float64Array(n),
    h: new Float64Array(n),
    headings: [],
    height: 0,
  };
  let top = 0;
  for (const item of items) {
    if (item.kind === "month") {
      placement.headings.push(top);
    } else {
      let left = 0;
      for (const tile of item.row.tiles) {
        const i = indexOf.get(tile.item.photoId);
        if (i !== undefined) {
          placement.x[i] = left;
          placement.y[i] = top;
          placement.w[i] = tile.width;
          placement.h[i] = item.row.height;
        }
        left += tile.width + item.gap;
      }
    }
    top += item.height;
  }
  placement.height = top;
  return placement;
}

/**
 * The two layouts a continuous row height falls between, and how far (0–1, on a log scale, as
 * zoom is felt). Past the smallest / largest step both are that step and `scale` says how far past.
 */
export function bracket(height: number, heights: readonly number[]) {
  const last = heights.length - 1;
  if (height <= heights[0]!) return { a: 0, b: 0, t: 0, scale: height / heights[0]! };
  if (height >= heights[last]!) return { a: last, b: last, t: 0, scale: height / heights[last]! };
  let a = 0;
  while (heights[a + 1]! < height) a++;
  const t = Math.log(height / heights[a]!) / Math.log(heights[a + 1]! / heights[a]!);
  return { a, b: a + 1, t, scale: 1 };
}

/**
 * The part of the way between two steps where the larger step dissolves in. Until then only the
 * smaller shows: scaled up, it covers the width and two grids never show at once, however long the
 * fingers stay. The larger is below scale 1 while it fades (it can't cover the width), hence late
 * and short. It ends before the larger's own size, so a small pinch from it doesn't flicker.
 */
export const FADE_FROM = 0.82;
export const FADE_TO = 0.95;

/** How far the larger step has faded in, at `t` of the way between two steps. */
export function fadeIn(t: number) {
  const x = Math.min(1, Math.max(0, (t - FADE_FROM) / (FADE_TO - FADE_FROM)));
  return x * x * (3 - 2 * x);
}

/**
 * The step a gesture started on `start` settles on when released at `height`: the nearest (on a log
 * scale, as zoom is felt), except that a layout the viewer sees stays: going smaller, the new grid
 * shows from early on, so it wins as soon as it has mostly replaced the old (user request).
 */
export function settleStep(height: number, heights: readonly number[], start: number) {
  const { a, b, t } = bracket(height, heights);
  if (a === b) return a;
  if (b <= start && fadeIn(t) < 0.5) return a;
  return t < 0.5 ? a : b;
}

/** The tile under (or nearest to) a point in grid coordinates. */
export function tileAt(placement: Placement, x: number, y: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < placement.x.length; i++) {
    const dx = Math.max(placement.x[i]! - x, 0, x - placement.x[i]! - placement.w[i]!);
    const dy = Math.max(placement.y[i]! - y, 0, y - placement.y[i]! - placement.h[i]!);
    // Rows first: a tile in the finger's row beats a closer one in the next row.
    const distance = dy * 1e4 + dx;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return best;
}
