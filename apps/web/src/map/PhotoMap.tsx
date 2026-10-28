import type { PhotoLocation } from "@photo-app/shared";
import type { FeatureCollection, Point } from "geojson";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Bundled as its own module worker (`worker.format` in vite.config.ts), served from the app's
// origin like every other asset, so the CSP's `worker-src 'self'` covers it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { markerElement } from "./markers";
import { mapStyleUrl } from "./style";

setWorkerUrl(workerUrl);

const SOURCE = "photos";
/** Photos at the same (rounded) spot never split up; past this zoom a cluster opens as a strip. */
const CLUSTER_MAX_ZOOM = 16;
const MAX_ZOOM = 18;
/** The first view shows all photos, but not closer than this (a single photo: the town). */
const FIT_MAX_ZOOM = 12;

/**
 * The user's photos on a map (13.2h): thumbnail pins, grouped into clusters with a count (the
 * newest photo on top). Tapping a cluster zooms in until it splits; one that can't split (photos
 * taken at the same spot) shows its photos in a strip instead. Tapping a photo opens the viewer.
 */
export function PhotoMap({
  photos,
  onOpen,
  className,
}: {
  photos: PhotoLocation[];
  onOpen: (photo: PhotoLocation) => void;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Pins on screen by photo ID or cluster; built from the data, so new data starts afresh.
  const markersRef = useRef(new Map<string, Marker>());
  // Read by the map's event handlers, which are set up once.
  const photosRef = useRef(photos);
  const onOpenRef = useRef(onOpen);
  // Photo IDs of the cluster opened as a strip; looked up in `photos`, so deleted ones drop out.
  const [stripIds, setStripIds] = useState<string[] | null>(null);
  const strip = useMemo(() => {
    if (!stripIds) return null;
    const byId = new Map(photos.map((photo) => [photo.photoId, photo]));
    const found = stripIds.flatMap((id) => byId.get(id) ?? []);
    return found.length > 0 ? found : null;
  }, [photos, stripIds]);

  useEffect(() => {
    photosRef.current = photos;
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const map = new MapLibreMap({
      container: container.current!,
      style: mapStyleUrl(dark.matches),
      bounds: bounds(photosRef.current),
      fitBoundsOptions: { padding: 48, maxZoom: FIT_MAX_ZOOM },
      maxZoom: MAX_ZOOM,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // A new style (dark mode switched) drops the source, so it's added on every style load.
    map.on("style.load", () => {
      map.addSource(SOURCE, {
        type: "geojson",
        data: features(photosRef.current),
        cluster: true,
        clusterRadius: 56,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        // The cluster's cover: its newest photo (the list is newest first).
        clusterProperties: { cover: ["min", ["get", "cover"]] },
      });
      // Invisible; a source only loads while a layer uses it. The pins are HTML markers.
      map.addLayer({
        id: SOURCE,
        type: "circle",
        source: SOURCE,
        paint: { "circle-radius": 0, "circle-opacity": 0 },
      });
    });
    const switchStyle = () => map.setStyle(mapStyleUrl(dark.matches));
    dark.addEventListener("change", switchStyle);

    async function openCluster(clusterId: number, center: [number, number]) {
      const source = map.getSource<GeoJSONSource>(SOURCE);
      if (!source) return;
      const zoom = await source.getClusterExpansionZoom(clusterId);
      if (zoom <= CLUSTER_MAX_ZOOM) {
        map.easeTo({ center, zoom });
        return;
      }
      const leaves = await source.getClusterLeaves(clusterId, Infinity, 0);
      const list = photosRef.current;
      setStripIds(leaves.flatMap((leaf) => list[leaf.properties!.cover as number]?.photoId ?? []));
    }

    // Markers for what's on screen, rebuilt only for clusters/photos that changed.
    const markers = markersRef.current;
    function updateMarkers() {
      if (!map.getSource(SOURCE) || !map.isSourceLoaded(SOURCE)) return;
      const list = photosRef.current;
      const seen = new Set<string>();
      for (const feature of map.querySourceFeatures(SOURCE)) {
        const props = feature.properties;
        const clusterId = props.cluster_id as number | undefined;
        const count = (props.point_count as number | undefined) ?? 1;
        const photo = list[props.cover as number];
        if (!photo) continue;
        const key = clusterId === undefined ? photo.photoId : `cluster:${clusterId}:${count}`;
        if (seen.has(key)) continue; // A feature can be in several tiles.
        seen.add(key);
        if (markers.has(key)) continue;
        const [lon, lat] = (feature.geometry as Point).coordinates as [number, number];
        const element = markerElement(photo, count, () => {
          if (clusterId === undefined) onOpenRef.current(photo);
          else void openCluster(clusterId, [lon, lat]);
        });
        markers.set(key, new Marker({ element }).setLngLat([lon, lat]).addTo(map));
      }
      for (const [key, marker] of markers) {
        if (seen.has(key)) continue;
        marker.remove();
        markers.delete(key);
      }
    }
    map.on("render", updateMarkers);

    return () => {
      dark.removeEventListener("change", switchStyle);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // New data (a photo deleted or processed meanwhile): same view, new pins.
  useEffect(() => {
    const markers = markersRef.current;
    for (const marker of markers.values()) marker.remove();
    markers.clear();
    mapRef.current?.getSource<GeoJSONSource>(SOURCE)?.setData(features(photos));
  }, [photos]);

  return (
    <div className={cn("relative", className)}>
      <div ref={container} className="size-full" />
      {strip && (
        <section
          aria-label={`${strip.length} photos taken here`}
          className="absolute inset-x-2 bottom-2 z-10 rounded-lg border bg-background/95 p-2 shadow-lg backdrop-blur"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
            <p className="text-sm font-medium">{strip.length} photos taken here</p>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setStripIds(null)}
              className="rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
          <ul className="flex gap-1.5 overflow-x-auto pb-1">
            {strip.map((photo) => (
              <li key={photo.photoId} className="shrink-0">
                <button
                  type="button"
                  aria-label={`Open photo from ${dateFormat.format(new Date(photo.takenAt))}`}
                  onClick={() => onOpen(photo)}
                  className="block size-16 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <img src={photo.thumbUrl} alt="" className="size-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** `cover` is the photo's index in the newest-first list; clusters keep the smallest. */
function features(photos: PhotoLocation[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: photos.map((photo, index) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [photo.lon, photo.lat] },
      properties: { cover: index },
    })),
  };
}

function bounds(photos: PhotoLocation[]): LngLatBounds {
  const box = new LngLatBounds();
  for (const photo of photos) box.extend([photo.lon, photo.lat]);
  return box;
}
