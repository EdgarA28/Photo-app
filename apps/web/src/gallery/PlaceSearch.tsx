import type { Place, PlaceKind } from "@photo-app/shared";
import { useQuery } from "@tanstack/react-query";
import { Globe, Map as MapIcon, MapPin, Search, type LucideIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { Api } from "@/api/api";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { placesQuery } from "@/queries/places";
import { matchPlaces } from "./placeMatch";

const KIND_ICONS: Record<PlaceKind, LucideIcon> = { city: MapPin, region: MapIcon, country: Globe };

/**
 * Search box over the user's places (13.2f): a combobox (ARIA 1.2 pattern) that filters the
 * place list as the user types. The list is small (one entry per town, region and country with
 * photos), so it is loaded once and matched in the browser; DynamoDB has no text search.
 */
export function PlaceSearch({
  api,
  onPick,
  className,
}: {
  api: Api;
  onPick: (place: Place) => void;
  className?: string;
}) {
  const { data, isPending, isError } = useQuery(placesQuery(api));
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => matchPlaces(data?.items ?? [], query), [data, query]);
  const showList = open && query.trim() !== "";

  const pick = (place: Place) => {
    setQuery("");
    setOpen(false);
    onPick(place);
  };

  return (
    <div className={cn("relative", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        role="combobox"
        aria-label="Search places"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        placeholder="Search places"
        autoComplete="off"
        className="pl-8"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (results.length === 0) return;
            const step = event.key === "ArrowDown" ? 1 : -1;
            setOpen(true);
            setActive((i) => (i + step + results.length) % results.length);
          } else if (event.key === "Enter" && showList && results[active]) {
            event.preventDefault();
            pick(results[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md">
          {/* Always rendered while open, so aria-controls points at something. */}
          <ul id={listId} role="listbox" aria-label="Places">
            {results.map((place, index) => {
              const Icon = KIND_ICONS[place.kind];
              return (
                <li
                  key={place.placeId}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  // Keeps the focus in the input, so the blur doesn't close the list first.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(place)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 aria-selected:bg-muted"
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{place.name}</span>
                    {place.context && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {place.context}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {place.photoCount}
                  </span>
                </li>
              );
            })}
          </ul>
          {results.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">
              {isPending
                ? "Loading places…"
                : isError
                  ? "Places couldn't be loaded."
                  : data?.items.length
                    ? `No places match “${query.trim()}”.`
                    : "No places yet. Photos with a location show up here once they're processed."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
