import { queryOptions } from "@tanstack/react-query";
import type { Api } from "@/api/api";

/** The user's places for search (13.2f), most photos first. */
export const placesQuery = (api: Api) =>
  queryOptions({
    queryKey: ["places"],
    queryFn: ({ signal }) => api.places.list({ signal }),
  });

/** Map pins (13.2h): the user's photos with GPS, newest first. */
export const photoLocationsQuery = (api: Api) =>
  queryOptions({
    queryKey: ["places", "map"],
    queryFn: ({ signal }) => api.places.map({ signal }),
  });
