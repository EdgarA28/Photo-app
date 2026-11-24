import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Api } from "@/api/api";

/**
 * The Duplicates page's groups (8.37g, FR-GAL-12). Under ["photos"], so uploads, deletes and
 * restores refresh it with the lists.
 */
export const duplicatesQuery = (api: Api) =>
  queryOptions({
    queryKey: ["photos", "duplicates"],
    queryFn: ({ signal }) => api.photos.duplicates({ signal }),
  });

/** "Not duplicates" for a group; the list is refetched either way (a 409 means it changed). */
export function useDismissDuplicates() {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, photoIds }: { key: string; photoIds: string[] }) =>
      api.photos.dismissDuplicates(key, photoIds),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["photos", "duplicates"] }),
  });
}
