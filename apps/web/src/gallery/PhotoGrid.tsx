import type { Photo } from "@photo-app/shared";
import { Link } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Check, ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useImageFailed } from "@/components/useImageFailed";
import { VideoBadge } from "@/components/VideoBadge";
import { videoLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { GAP, gridItems, MONTH_HEADING_HEIGHT, type GridItem } from "./gridLayout";
import type { GallerySearch } from "./search";
import { TILE_ATTRIBUTE, useDragSelect } from "./useDragSelect";
import { rowHeightFor, useGridZoom } from "./useGridZoom";
import { usePinchLayer, type PinchLayerState } from "./usePinchLayer";

/** Start loading the next page this many rows before the end (FR-GAL-2). */
const LOOKAHEAD_ROWS = 6;

/** Select mode (8.11): tiles toggle instead of opening the viewer. */
export interface GridSelection {
  selected: ReadonlySet<string>;
  onToggle: (photoId: string) => void;
}

interface PhotoGridProps {
  photos: Photo[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  /** The list the viewer walks (FR-GAL-4); default: the current page's search params. */
  viewerSearch?: GallerySearch | undefined;
  selection?: GridSelection | undefined;
  /** Press and slide on the tiles picks photos (useDragSelect), starting select mode. */
  onSelectionChange?: ((selected: ReadonlySet<string>) => void) | undefined;
  /** A heading per month of date taken; only for lists ordered by date taken. */
  months?: boolean | undefined;
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
    () => gridItems(photos, width, rowHeightFor(width, zoom), months),
    [photos, width, months, zoom],
  );
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

  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= items.length - LOOKAHEAD_ROWS) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lastIndex, items.length]);

  return (
    <div
      ref={ref}
      // Two-finger pinch resizes the tiles instead of zooming the page (useGridZoom).
      className="group relative w-full touch-pan-x touch-pan-y"
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
            style={{ gap: GAP, height: row.height, transform: translate }}
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

const HEADING_CLASS = "absolute top-0 flex items-end pb-2 text-sm font-medium text-foreground";
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
          className="absolute top-0 left-0 h-0 w-full origin-top-left will-change-transform motion-safe:transition-opacity motion-safe:duration-200 motion-safe:ease-linear"
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
