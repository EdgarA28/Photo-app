import type { MeResponse } from "@photo-app/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Api } from "@/api/api";

/** GET /me: profile, username and usage (FR-ACC-1); invalidated after uploads and deletes. */
export const meQuery = (api: Api) =>
  queryOptions({
    queryKey: ["me"],
    queryFn: ({ signal }) => api.me.get({ signal }),
  });

/**
 * Sets or changes the username (FR-ACC-3). The API answers with the normalised name, which goes
 * into `["me"]` at once before the refetch confirms it.
 */
export function useSetUsername() {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.me.setUsername(username),
    onSuccess: ({ username }) => {
      queryClient.setQueryData<MeResponse>(["me"], (me) => (me ? { ...me, username } : me));
      return queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
}
