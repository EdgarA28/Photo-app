/**
 * Map tiles from OpenFreeMap (13.2h, decided 2026-10-28): free vector tiles, no key or account.
 * Only the map view (which area is looked at) reaches it, never the photos' coordinates. The host
 * is in the CSP's `connect-src` (infra/modules/frontend).
 */
export const MAP_TILE_ORIGIN = "https://tiles.openfreemap.org";

/** Light or dark to match the app (index.css follows `prefers-color-scheme`). */
export function mapStyleUrl(dark: boolean): string {
  return `${MAP_TILE_ORIGIN}/styles/${dark ? "dark" : "positron"}`;
}
