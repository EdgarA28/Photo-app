import { queryOptions } from "@tanstack/react-query";
import type { Api } from "@/api/api";

/** GET /me: profile, username and usage (FR-ACC-1); invalidated after uploads and deletes. */
export const meQuery = (api: Api) =>
  queryOptions({
    queryKey: ["me"],
    queryFn: ({ signal }) => api.me.get({ signal }),
  });
