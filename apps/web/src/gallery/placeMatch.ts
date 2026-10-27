import type { Place } from "@photo-app/shared";

const MAX_RESULTS = 8;

/** Case- and accent-insensitive form for matching ("München" ~ "munchen"). */
export const normalizeForSearch = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * Places matching what was typed (13.2f): names that start with it first, then names containing
 * it, then places whose region/country matches; within each, the API's order (most photos first).
 */
export function matchPlaces(places: readonly Place[], query: string): Place[] {
  const q = normalizeForSearch(query);
  if (!q) return [];
  const rank = (place: Place) => {
    const name = normalizeForSearch(place.name);
    if (name.startsWith(q) || name.split(/[\s-]+/).some((word) => word.startsWith(q))) return 0;
    if (name.includes(q)) return 1;
    if (normalizeForSearch(place.context).includes(q)) return 2;
    return 3;
  };
  return places
    .map((place, index) => ({ place, index, rank: rank(place) }))
    .filter((m) => m.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map((m) => m.place);
}
