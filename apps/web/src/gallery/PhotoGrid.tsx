import type { Photo } from "@photo-app/shared";
import { Link } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Check, ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useImageFailed } from "@/components/useImageFailed";
import { VideoBadge } from "@/components/VideoBadge";
import { videoLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { gridItems, MONTH_HEADING_HEIGHT, rowHeightFor, type GridItem } from "./gridLayout";
import type { GallerySearch } from "./search";
import { TILE_ATTRIBUTE, useDragSelect } from "./useDragSelect";
import { useGridZoom } from "./useGridZoom";
import { usePinchLayer, type PinchLayerState } from "./usePinchLayer";

/** Start loading the next page this many rows before the end (FR-GAL-2), or the top (8.36). */
const LOOKAHEAD_ROWS = 6;

/** Where a month's heading is, in page coordinates (`window.scrollY` units), for the scrubber. */
export interface MonthOffset {
  month: string;
  top: number;
}

/** Select mode (8.11): tiles toggle instead of opening the viewer. */
export interface GridSelection {
  selected: ReadonlySet<string>;
  onToggle: (photoId: string) => void;
}

interface PhotoGridProps {
  photos: Photo[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: (options?: { cancelRefetch?: boolean }) => unknown;
  /** The list the viewer walks (FR-GAL-4); default: the current page's search params. */
  viewerSearch?: GallerySearch | undefined;
  selection?: GridSelection | undefined;
  /** Press and slide on the tiles picks photos (useDragSelect), starting select mode. */
  onSelectionChange?: ((selected: ReadonlySet<string>) => void) | undefined;
  /** A heading per month of date taken; only for lists ordered by date taken. */
  months?: boolean | undefined;
  /** A list that started mid-way (timeline jump, 8.36) loads newer pages above. */
  hasPreviousPage?: boolean | undefined;
  isFetchingPreviousPage?: boolean | undefined;
  fetchPreviousPage?: ((options?: { cancelRefetch?: boolean }) => unknown) | undefined;
  /** Any fetch of the list running (a refresh would cancel the request for newer photos). */
  isFetching?: boolean | undefined;
  /** The month headings' positions after each layout (the timeline scrubber, 8.36). */
  onMonthOffsets?: ((offsets: MonthOffset[]) => void) | undefined;
}

/**
 * Virtualized justified grid (§12.3, FR-GAL-2, NFR-PERF-3): only the rows near the viewport are in
 * the DOM, scrolled with the page so the browser's own scrolling, the router's scroll restoration
 * and the mobile address bar behave normally. Pinch (or a trackpad pinch) changes the tile size in
 * steps (FR-GAL-8, `useGridZoom`).
 */
export function PhotoGrid({
  photos,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  viewerSearch,
  selection,
  onSelectionChange,
  months = false,
  hasPreviousPage = false,
  isFetchingPreviousPage = false,
  fetchPreviousPage,
  isFetching = false,
  onMonthOffsets,
}: PhotoGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { width, top } = useElementBox(ref);
  const heightOf = (step: number) => rowHeightFor(width, step);
  // Pinch to resize the tiles (FR-GAL-8): `useGridZoom` reads the fingers, `usePinchLayer` shows
  // the grid between two steps meanwhile and hands over to the new step's layout.
  // The layout a gesture starts from (read by the listeners, refreshed after each render).
  const current = useRef<{ items: readonly GridItem[]; zoom: number }>({ items: [], zoom: 0 });
  const pinch = usePinchLayer({
    grid: ref,
    photos,
    width,
    months,
    heightOf,
    current: () => current.current,
  });
  const { zoom } = useGridZoom(ref, { heightOf, ...pinch.callbacks });
  const items = useMemo(
    () => gridItems(photos, width, zoom, months),
    [photos, width, months, zoom],
  );
  // Photos loaded above (8.36: scrolling up after a timeline jump) push everything down: keep the
  // photo that was at the top of the screen where it was. Runs before `current` takes the new
  // layout, so it still has the old one to measure against.
  const shownFirst = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const before = shownFirst.current;
    shownFirst.current = photos[0]?.photoId;
    if (!before || before === photos[0]?.photoId) return;
    if (!photos.some((photo, i) => i > 0 && photo.photoId === before)) return;
    const anchor = topVisiblePhoto(current.current.items, window.scrollY - top);
    if (!anchor) return;
    const start = startOfPhoto(items, anchor.photoId);
    if (start !== null) window.scrollTo(0, top + start + anchor.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  useLayoutEffect(() => {
    current.current = { items, zoom };
  });

  const photoIds = useMemo(() => photos.map((photo) => photo.photoId), [photos]);
  const dragStartedInSelect = useDragSelect({
    container: ref,
    photoIds,
    selected: selection?.selected,
    onChange: onSelectionChange,
  });

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: (index) => items[index]!.height,
    overscan: 4,
    scrollMargin: top,
  });
  // Heights are computed, not measured: drop cached sizes when the layout changes (before paint,
  // so a zoom step never shows rows at their old offsets); after a pinch's new step, the layer
  // hands over (it scrolls to where it showed the grid, so the height must already be the new one).
  const totalHeight = useMemo(() => items.reduce((sum, item) => sum + item.height, 0), [items]);
  useLayoutEffect(() => {
    virtualizer.measure();
    pinch.onLayout(zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer, items]);

  // Month headings for the timeline scrubber (8.36), whenever the layout changes.
  useLayoutEffect(() => {
    if (!onMonthOffsets) return;
    let y = top;
    const offsets: MonthOffset[] = [];
    for (const item of items) {
      if (item.kind === "month") offsets.push({ month: item.month, top: y });
      y += item.height;
    }
    onMonthOffsets(offsets);
  }, [items, top, onMonthOffsets]);

  const virtualRows = virtualizer.getVirtualItems();
  const firstIndex = virtualRows[0]?.index ?? -1;
  // Newer photos above a list that started mid-way: only while nothing else fetches the list (a
  // refresh would cancel the request), once per state of the list (asking again while the page
  // is being added looped in the harness, 2026-11-22).
  const firstPhotoId = photos[0]?.photoId;
  const askedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!hasPreviousPage || isFetching || isFetchingPreviousPage || firstIndex < 0) return;
    if (firstIndex >= LOOKAHEAD_ROWS || askedFor.current === firstPhotoId) return;
    // A tick later: effects run child first, so right after a jump the parent's query hook hasn't
    // switched to the new list yet and the request would go to the old one (seen 2026-11-22).
    const timer = window.setTimeout(() => {
      askedFor.current = firstPhotoId;
      // Never cancels a fetch in flight (that one would be lost); it asks again once idle.
      void fetchPreviousPage?.({ cancelRefetch: false });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    hasPreviousPage,
    isFetching,
    isFetchingPreviousPage,
    fetchPreviousPage,
    firstIndex,
    firstPhotoId,
  ]);
  // A fetch that ended without new photos above (e.g. cancelled by a refresh) may be asked again.
  useEffect(() => {
    if (!isFetching) askedFor.current = undefined;
  }, [isFetching]);
  const lastIndex = virtualRows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchingPreviousPage &&
      lastIndex >= items.length - LOOKAHEAD_ROWS
    ) {
      // A tick later, and without cancelling a fetch in flight, as for the previous page below
      // (both ends of a short list after a jump are on screen at once).
      const timer = window.setTimeout(() => void fetchNextPage({ cancelRefetch: false }), 0);
      return () => window.clearTimeout(timer);
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    isFetchingPreviousPage,
    fetchNextPage,
    lastIndex,
    items.length,
  ]);

  return (
    <div
      ref={ref}
      // Two-finger pinch resizes the tiles instead of zooming the page (useGridZoom). On a phone
      // the grid goes over the page padding to the screen's edges, as in Google Photos.
      className="group relative -mx-4 touch-pan-x touch-pan-y md:mx-0"
      style={{ height: totalHeight }}
    >
      {virtualRows.map((virtualRow) => {
        const item = items[virtualRow.index]!;
        const translate = `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`;
        if (item.kind === "month") {
          return (
            <h2
              key={virtualRow.key}
              className={cn(HEADING_CLASS, "inset-x-0", HIDDEN_WHILE_PINCHING)}
              style={{ height: item.height, transform: translate }}
            >
              {item.label}
            </h2>
          );
        }
        const { row } = item;
        return (
          <div
            key={virtualRow.key}
            className={cn("absolute inset-x-0 top-0 flex", HIDDEN_WHILE_PINCHING)}
            style={{ gap: item.gap, height: row.height, transform: translate }}
          >
            {row.tiles.map(({ item, width }) => (
              <PhotoTile
                key={item.photoId}
                photo={item}
                width={width}
                viewerSearch={viewerSearch}
                selection={selection}
                asButton={dragStartedInSelect ?? selection !== undefined}
              />
            ))}
          </div>
        );
      })}
      {pinch.layer && (
        <PinchLayer layer={pinch.layer} stepRef={pinch.stepRef} selection={selection} />
      )}
    </div>
  );
}

// The grid has no side padding on a phone; its headings keep the page's.
const HEADING_CLASS =
  "absolute top-0 flex items-end px-4 pb-2 text-sm font-medium text-foreground md:px-0";
// The pinch layer stands in for the rows while it shows (usePinchLayer's PINCHING_ATTRIBUTE;
// a literal, for Tailwind's class scanner).
const HIDDEN_WHILE_PINCHING = "group-data-pinching:invisible";

/** The grids of the steps a pinch is between (FR-GAL-8), moved as wholes by `usePinchLayer`. */
function PinchLayer({
  layer,
  stepRef,
  selection,
}: {
  layer: PinchLayerState;
  stepRef: (step: number) => (node: HTMLElement | null) => void;
  selection: GridSelection | undefined;
}) {
  return (
    <div
      aria-hidden
      data-pinch-layer=""
      // Clipped to the grid's top and sides (scaled up, it would cover the page around it and
      // scroll it sideways), open at the bottom (the grid's real height is the old step's).
      className="pointer-events-none absolute inset-0 overflow-x-clip [clip-path:inset(0_0_-100000px_0)]"
    >
      {layer.steps.map(({ step, placement, tiles }) => (
        <div
          key={step}
          ref={stepRef(step)}
          data-pinch-step={step}
          // The dissolve takes its time however fast the fingers pass through it.
          className="absolute top-0 left-0 h-0 w-full origin-top-left will-change-transform motion-safe:data-placed:transition-opacity motion-safe:data-placed:duration-200 motion-safe:data-placed:ease-linear"
        >
          {/* Solid behind the tiles: the grid below would otherwise show through the gaps while this
              one dissolves in, as flickering lines. */}
          <div
            data-pinch-backdrop=""
            className="absolute inset-x-0 top-0 bg-background"
            style={{ height: placement.height }}
          />
          {layer.headings.map((label, j) => (
            <h2
              key={label}
              className={cn(HEADING_CLASS, "left-0 w-full")}
              style={{
                height: MONTH_HEADING_HEIGHT,
                transform: `translateY(${placement.headings[j]}px)`,
              }}
            >
              {label}
            </h2>
          ))}
          {tiles.map((i) => {
            const photo = layer.photos[i]!;
            const failed = photo.status === "failed";
            return (
              <div
                key={photo.photoId}
                data-pinch-tile={photo.photoId}
                className={cn(
                  "absolute top-0 left-0 flex items-center justify-center overflow-hidden",
                  failed ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
                )}
                style={{
                  width: placement.w[i],
                  height: placement.h[i],
                  transform: `translate(${placement.x[i]}px, ${placement.y[i]}px)`,
                }}
              >
                <TileContent photo={photo} eager />
                {selection && <SelectMark selected={selection.selected.has(photo.photoId)} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const STATUS_LABELS = {
  pending: "processing",
  failed: "couldn't be processed",
} as const;

function PhotoTile({
  photo,
  width,
  viewerSearch,
  selection,
  asButton,
}: {
  photo: Photo;
  width: number;
  viewerSearch: GallerySearch | undefined;
  selection: GridSelection | undefined;
  /** Select mode's toggle button, else the viewer link (kept as is during a drag, useDragSelect). */
  asButton: boolean;
}) {
  const selected = selection?.selected.has(photo.photoId) ?? false;
  const failed = photo.status === "failed";
  const video = photo.mediaType === "video";
  const label = [
    photo.fileName,
    // A video says so, with its length once processed (FR-VID-4).
    video && videoLabel(photo.durationMs),
    photo.status !== "ready" && STATUS_LABELS[photo.status],
  ]
    .filter(Boolean)
    .join(", ");
  const className = cn(
    // A press shows nothing until it selects (no Android tap highlight), and no iOS link preview /
    // image callout, link dragging or text selection on a long press.
    "relative flex h-full shrink-0 items-center justify-center overflow-hidden outline-offset-2 select-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] [-webkit-user-drag:none] focus-visible:outline-2 focus-visible:outline-ring",
    failed ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
  );

  const tile = { [TILE_ATTRIBUTE]: photo.photoId, className, style: { width } };

  if (selection && asButton) {
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={() => selection.onToggle(photo.photoId)}
        {...tile}
      >
        <TileContent photo={photo} />
        <SelectMark selected={selected} />
      </button>
    );
  }

  return (
    <Link
      to="/photos/$photoId"
      params={{ photoId: photo.photoId }}
      // Keeps album/sort, so the viewer's prev/next follow this list (FR-GAL-4).
      search={viewerSearch ?? ((prev) => prev)}
      aria-label={label}
      title={failed ? `This ${video ? "video" : "photo"} couldn't be processed` : undefined}
      draggable={false}
      {...tile}
    >
      <TileContent photo={photo} />
      {selection && <SelectMark selected={selected} />}
    </Link>
  );
}

/** Select mode's check circle and frame. */
function SelectMark({ selected }: { selected: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-full border-2 transition-colors",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-white/90 bg-black/20",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
      {selected && <span aria-hidden className="absolute inset-0 ring-3 ring-primary ring-inset" />}
    </>
  );
}

function TileContent({ photo, eager = false }: { photo: Photo; eager?: boolean }) {
  // A thumbnail that can't load keeps the placeholder (until a refetch brings a new URL).
  const [broken, onError] = useImageFailed(photo.thumbUrl);
  return (
    <>
      {/* FR-GAL-5: processing → spinner placeholder, failed → error state. */}
      {photo.status === "pending" && (
        <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" />
      )}
      {photo.status === "failed" && (
        <span className="flex flex-col items-center gap-1 text-xs font-medium">
          <ImageOff aria-hidden className="size-5" />
          Failed
        </span>
      )}
      {photo.status === "ready" && photo.thumbUrl && !broken && (
        <img
          src={photo.thumbUrl}
          alt=""
          // The pinch layer's copies are already loaded (or about to show): no lazy wait.
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={onError}
          className="size-full object-cover"
        />
      )}
      {photo.mediaType === "video" && photo.status === "ready" && (
        <VideoBadge durationMs={photo.durationMs} />
      )}
    </>
  );
}

/** Width of the element and its top in document coordinates (the virtualizer's scroll margin). */
function useElementBox(ref: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ width: 0, top: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const top = element.getBoundingClientRect().top + window.scrollY;
      setBox((prev) => (prev.width === width && prev.top === top ? prev : { width, top }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

/** The first photo of the row at `offset` (grid coordinates) and how far into its row that is. */
function topVisiblePhoto(
  items: readonly GridItem[],
  offset: number,
): { photoId: string; offset: number } | null {
  // Above the grid's top (e.g. right after a jump, the grid under the header): the first row.
  if (offset < 0) {
    const index = items.findIndex((item) => item.kind === "row");
    const first = items[index];
    if (!first || first.kind !== "row") return null;
    const rowStart = items.slice(0, index).reduce((sum, item) => sum + item.height, 0);
    return { photoId: first.row.tiles[0]!.item.photoId, offset: offset - rowStart };
  }
  let y = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (offset < y + item.height) {
      // A heading: anchor on the row below it, keeping the heading's distance.
      const row = item.kind === "row" ? item : items[i + 1];
      if (!row || row.kind !== "row") return null;
      const rowStart = item.kind === "row" ? y : y + item.height;
      return { photoId: row.row.tiles[0]!.item.photoId, offset: offset - rowStart };
    }
    y += item.height;
  }
  return null;
}

/** Where the row holding `photoId` starts (grid coordinates), or null. */
function startOfPhoto(items: readonly GridItem[], photoId: string): number | null {
  let y = 0;
  for (const item of items) {
    if (item.kind === "row" && item.row.tiles.some((tile) => tile.item.photoId === photoId)) {
      return y;
    }
    y += item.height;
  }
  return null;
}
