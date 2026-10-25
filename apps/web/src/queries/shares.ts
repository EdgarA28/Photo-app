import type { AlbumShare, AlbumShareList, CreateShareRequest } from "@photo-app/shared";
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Api } from "@/api/api";
import { signedUrlRefreshInterval } from "./signedUrls";

/** GET /albums/{id}/shares: who an own album is shared with (FR-SHR-1/2, owner only). */
export const sharesQuery = (api: Api, albumId: string) =>
  queryOptions({
    queryKey: ["albums", albumId, "shares"],
    queryFn: ({ signal }) => api.albums.shares(albumId, { signal }),
  });

/** GET /shared-albums: albums others shared with me, page by page (FR-SHR-3). */
export const sharedAlbumsQuery = (api: Api) =>
  infiniteQueryOptions({
    queryKey: ["shared-albums"],
    queryFn: ({ pageParam, signal }) => api.sharedAlbums.list({ cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Covers are signed URLs (7.4).
    refetchInterval: ({ state: { data } }) =>
      signedUrlRefreshInterval(
        data?.pages.flatMap((page) => page.items.map((a) => a.coverThumbUrl)) ?? [],
      ),
  });

function useApi() {
  return useRouteContext({ from: "__root__", select: (context) => context.api });
}

/**
 * Shares an album by email or username (FR-SHR-1/5). The API answers with the existing share when
 * it already existed; `alreadyShared` says so, from the list as it was before.
 */
export function useShareAlbum(albumId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = sharesQuery(api, albumId).queryKey;
  return useMutation({
    mutationFn: async (request: CreateShareRequest) => {
      const share = await api.albums.share(albumId, request);
      const before = queryClient.getQueryData<AlbumShareList>(key);
      return { share, alreadyShared: !!before?.items.some((s) => s.userId === share.userId) };
    },
    onSuccess: ({ share }) => {
      queryClient.setQueryData<AlbumShareList>(key, (data) =>
        data ? { items: [...data.items.filter((s) => s.userId !== share.userId), share] } : data,
      );
      return queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/** Revokes a share at once (FR-SHR-2); the recipient loses access immediately (5.13). */
export function useRevokeShare(albumId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = sharesQuery(api, albumId).queryKey;
  return useMutation({
    mutationFn: (share: AlbumShare) => api.albums.unshare(albumId, share.userId),
    onSuccess: (_data, share) => {
      queryClient.setQueryData<AlbumShareList>(key, (data) =>
        data ? { items: data.items.filter((s) => s.userId !== share.userId) } : data,
      );
      return queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
