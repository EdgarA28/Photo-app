import {
  MAX_PHOTOS_PER_SAVE_REQUEST,
  type AlbumShare,
  type AlbumShareList,
  type CreateShareRequest,
  type SaveSharedPhotosResponse,
  type ShareInvitationPage,
  type SharedAlbumPage,
} from "@photo-app/shared";
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Api } from "@/api/api";
import { batches } from "./albums";
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
    // `?? undefined`: restored from the saved cache (9.3) the first page's param is `null`.
    queryFn: ({ pageParam, signal }) =>
      api.sharedAlbums.list({ cursor: pageParam ?? undefined }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Covers are signed URLs (7.4).
    refetchInterval: ({ state: { data } }) =>
      signedUrlRefreshInterval(
        data?.pages.flatMap((page) => page.items.map((a) => a.coverThumbUrl)) ?? [],
      ),
  });

/** GET /share-invitations: albums I was invited to and haven't accepted (FR-SHR-6). */
export const shareInvitationsQuery = (api: Api) =>
  infiniteQueryOptions({
    queryKey: ["share-invitations"],
    queryFn: ({ pageParam, signal }) =>
      api.shareInvitations.list({ cursor: pageParam ?? undefined }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
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

/** Drops an album from a cached infinite list of invitations or shared albums at once. */
function dropFromPages<T extends ShareInvitationPage | SharedAlbumPage>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  albumId: string,
) {
  queryClient.setQueryData<InfiniteData<T>>(queryKey, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((a) => a.albumId !== albumId),
          })),
        }
      : data,
  );
}

/** Accepts an invitation (FR-SHR-6): it leaves the invitations and shows up in Shared with me. */
export function useAcceptInvitation() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (albumId: string) => api.sharedAlbums.accept(albumId),
    onSuccess: (_data, albumId) => {
      dropFromPages(queryClient, shareInvitationsQuery(api).queryKey, albumId);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: shareInvitationsQuery(api).queryKey }),
        queryClient.invalidateQueries({ queryKey: sharedAlbumsQuery(api).queryKey }),
      ]);
    },
  });
}

/**
 * Declines an invitation or removes an album shared with me (FR-SHR-7). Access ends at once, so
 * its cached photos go too.
 */
export function useLeaveSharedAlbum({
  beforeCacheUpdate,
}: { beforeCacheUpdate?: () => Promise<void> | void } = {}) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (albumId: string) => api.sharedAlbums.leave(albumId),
    onSuccess: async (_data, albumId) => {
      // e.g. leave the album page first, so it doesn't refetch the photos it no longer may see.
      await beforeCacheUpdate?.();
      dropFromPages(queryClient, shareInvitationsQuery(api).queryKey, albumId);
      dropFromPages(queryClient, sharedAlbumsQuery(api).queryKey, albumId);
      queryClient.removeQueries({ queryKey: ["photos", { album: albumId }] });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: shareInvitationsQuery(api).queryKey }),
        queryClient.invalidateQueries({ queryKey: sharedAlbumsQuery(api).queryKey }),
      ]);
    },
  });
}

/**
 * "Save to my gallery" (FR-SHR-10): copies photos of an album shared with me into my library, in
 * batches the API accepts, one after another. Resolves to every photo's result.
 */
export function useSaveSharedPhotos(albumId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (photoIds: string[]) => {
      const items: SaveSharedPhotosResponse["items"] = [];
      for (const batch of batches(photoIds, MAX_PHOTOS_PER_SAVE_REQUEST)) {
        items.push(...(await api.sharedAlbums.save(albumId, batch)).items);
      }
      return items;
    },
    // New photos in my gallery (processing tiles first), and the storage they reserve.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
        queryClient.invalidateQueries({ queryKey: ["me"] }),
      ]),
  });
}

/** What the save did, in one sentence or two (FR-SHR-10). */
export function saveSummary(items: SaveSharedPhotosResponse["items"]): string {
  const count = (result: string) => items.filter((item) => item.result === result).length;
  const saved = count("saved");
  const already = items.filter((item) => item.result === "already-saved");
  const inTrash = already.filter((item) => item.inTrash).length;
  const full = count("quota-exceeded");
  const unavailable = count("unavailable");
  const photos = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);
  const was = (n: number) => (n === 1 ? "was" : "were");

  if (items.length === 1) {
    if (saved) return "Saved to your gallery.";
    if (inTrash) return "You saved this photo before. It's in your trash: restore it from there.";
    if (already.length) return "Already in your gallery.";
    if (full) return "Not saved: your storage is full.";
    return "This photo is no longer available.";
  }
  const parts: string[] = [];
  if (saved) parts.push(`Saved ${photos(saved)} to your gallery.`);
  if (already.length) {
    parts.push(
      `${photos(already.length)} ${was(already.length)} already saved` +
        (inTrash ? ` (${inTrash} in your trash).` : "."),
    );
  }
  if (full) parts.push(`${photos(full)} didn't fit in your storage.`);
  if (unavailable) parts.push(`${photos(unavailable)} ${was(unavailable)} no longer available.`);
  return parts.join(" ");
}
