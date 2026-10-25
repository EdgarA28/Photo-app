import type { Photo } from "@photo-app/shared";
import { Link } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Check, ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { justifyRows } from "./justify";
import type { GallerySearch } from "./search";

const GAP = 4;
/** Row height to aim for; full rows end up a little taller or shorter to fill the width. */
const targetHeightFor = (width: number) => (width < 640 ? 112 : 192);
/** Start loading the next page this many rows before the end (FR-GAL-2). */
const LOOKAHEAD_ROWS = 6;

// Pending photos have no dimensions yet (they come from the thumbnail Lambda): square until ready.
const aspectOf = (photo: Photo) => (photo.width && photo.height ? photo.width / photo.height : 1);

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
}

/**
 * Virtualized justified grid (§12.3, FR-GAL-2, NFR-PERF-3): only the rows near the viewport are in
 * the DOM, scrolled with the page so the browser's own scrolling, the router's scroll restoration
 * and the mobile address bar behave normally.
 */
export function PhotoGrid({
  photos,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  viewerSearch,
  selection,
}: PhotoGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { width, top } = useElementBox(ref);
  const rows = useMemo(
    () =>
      width > 0
        ? justifyRows(photos, aspectOf, {
            containerWidth: width,
            targetHeight: targetHeightFor(width),
            gap: GAP,
          })
        : [],
    [photos, width],
  );

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (index) => rows[index]!.height + GAP,
    overscan: 4,
    scrollMargin: top,
  });
  // Row heights are computed, not measured: drop cached sizes when the layout changes.
  useEffect(() => virtualizer.measure(), [virtualizer, rows]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= rows.length - LOOKAHEAD_ROWS) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lastIndex, rows.length]);

  return (
    <div ref={ref} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index]!;
        return (
          <div
            key={virtualRow.key}
            className="absolute inset-x-0 top-0 flex"
            style={{
              gap: GAP,
              height: row.height,
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {row.tiles.map(({ item, width }) => (
              <PhotoTile
                key={item.photoId}
                photo={item}
                width={width}
                viewerSearch={viewerSearch}
                selection={selection}
              />
            ))}
          </div>
        );
      })}
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
}: {
  photo: Photo;
  width: number;
  viewerSearch: GallerySearch | undefined;
  selection: GridSelection | undefined;
}) {
  const failed = photo.status === "failed";
  const label =
    photo.status === "ready" ? photo.fileName : `${photo.fileName}, ${STATUS_LABELS[photo.status]}`;
  const className = cn(
    "relative flex h-full shrink-0 items-center justify-center overflow-hidden outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
    failed ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
  );

  if (selection) {
    const selected = selection.selected.has(photo.photoId);
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={() => selection.onToggle(photo.photoId)}
        className={className}
        style={{ width }}
      >
        <TileContent photo={photo} />
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
        {selected && (
          <span aria-hidden className="absolute inset-0 ring-3 ring-primary ring-inset" />
        )}
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
      title={failed ? "This photo couldn't be processed" : undefined}
      className={className}
      style={{ width }}
    >
      <TileContent photo={photo} />
    </Link>
  );
}

function TileContent({ photo }: { photo: Photo }) {
  // Until Phase 7 (CloudFront + media cookie) thumbnails don't load: keep the placeholder.
  const [broken, setBroken] = useState(false);
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
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
          className="size-full object-cover"
        />
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
