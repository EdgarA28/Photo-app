import { queryOptions } from "@tanstack/react-query";
import type { Api } from "@/api/api";

/** GET /albums: the user's own albums (FR-ALB-1); the gallery's album filter uses it too. */
export const albumsQuery = (api: Api) =>
  queryOptions({
    queryKey: ["albums"],
    queryFn: ({ signal }) => api.albums.list({ signal }),
  });
