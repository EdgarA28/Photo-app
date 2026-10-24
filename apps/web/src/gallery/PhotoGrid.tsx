import type { Photo } from "@photo-app/shared";
import { Link } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { justifyRows } from "./justify";

const GAP = 4;
/** Row height to aim for; full rows end up a little taller or shorter to fill the width. */
const targetHeightFor = (width: number) => (width < 640 ? 112 : 192);
/** Start loading the next page this many rows before the end (FR-GAL-2). */
const LOOKAHEAD_ROWS = 6;

// Pending photos have no dimensions yet (they come from the thumbnail Lambda): square until ready.
const aspectOf = (photo: Photo) => (photo.width && photo.height ? photo.width / photo.height : 1);

interface PhotoGridProps {
  photos: Photo[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
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
              <PhotoTile key={item.photoId} photo={item} width={width} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function PhotoTile({ photo, width }: { photo: Photo; width: number }) {
  // Until Phase 7 (CloudFront + media cookie) thumbnails don't load: keep the placeholder.
  const [broken, setBroken] = useState(false);
  return (
    <Link
      to="/photos/$photoId"
      params={{ photoId: photo.photoId }}
      aria-label={photo.fileName}
      className="block h-full shrink-0 overflow-hidden bg-muted outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
      style={{ width }}
    >
      {photo.thumbUrl && !broken && (
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
    </Link>
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
