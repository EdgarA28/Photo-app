import { queryOptions } from "@tanstack/react-query";
import type { Api } from "@/api/api";

/** The user's places for search (13.2f), most photos first. */
export const placesQuery = (api: Api) =>
  queryOptions({
    queryKey: ["places"],
    queryFn: ({ signal }) => api.places.list({ signal }),
  });
