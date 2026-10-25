import { MAX_PHOTOS_PER_ALBUM_REQUEST, type Album, type PhotoPage } from "@photo-app/shared";
import {
  queryOptions,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Api } from "@/api/api";

/** GET /albums: the user's own albums (FR-ALB-1); the gallery's album filter uses it too. */
export const albumsQuery = (api: Api) =>
  queryOptions({
    queryKey: ["albums"],
    queryFn: ({ signal }) => api.albums.list({ signal }),
  });

/** The key of an album's photo list (`galleryQuery` with `album`). */
const albumPhotosKey = (albumId: string) => ["photos", { album: albumId }] as const;

/** Drops photos from an album's cached list at once, before the refetch confirms. */
function removeFromAlbumCache(queryClient: QueryClient, albumId: string, photoIds: string[]) {
  const gone = new Set(photoIds);
  queryClient.setQueryData<InfiniteData<PhotoPage>>(albumPhotosKey(albumId), (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((p) => !gone.has(p.photoId)),
          })),
        }
      : data,
  );
}

/** `items` in consecutive groups of at most `size`. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function useApi() {
  return useRouteContext({ from: "__root__", select: (context) => context.api });
}

/** Mutation hooks for albums (FR-ALB-1/2). Each refreshes what shows the change. */

export function useCreateAlbum() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.albums.create({ name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["albums"] }),
  });
}

export function useUpdateAlbum(albumId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: { name: string } | { coverPhotoId: string | null }) =>
      api.albums.update(albumId, changes),
    // The answer is the updated album: show it at once, then confirm with the list.
    onSuccess: (album: Album) => {
      queryClient.setQueryData<{ items: Album[] }>(["albums"], (data) =>
        data ? { items: data.items.map((a) => (a.albumId === album.albumId ? album : a)) } : data,
      );
      return queryClient.invalidateQueries({ queryKey: ["albums"] });
    },
  });
}

/**
 * Deleting an album never deletes its photos (FR-ALB-1). `beforeCacheUpdate` lets the album page
 * navigate away first, so it never shows "not found" or refetches the deleted album's photos.
 */
export function useDeleteAlbum(
  albumId: string,
  { beforeCacheUpdate }: { beforeCacheUpdate?: () => Promise<void> | void } = {},
) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.albums.delete(albumId),
    onSuccess: async () => {
      await beforeCacheUpdate?.();
      queryClient.removeQueries({ queryKey: albumPhotosKey(albumId) });
      return queryClient.invalidateQueries({ queryKey: ["albums"] });
    },
  });
}

/**
 * Adds photos to an album (FR-ALB-2), in requests of at most 100 (the API's limit). The API is
 * idempotent, so photos already in the album and a repeated batch after a failure are fine.
 */
export function useAddToAlbum() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ albumId, photoIds }: { albumId: string; photoIds: string[] }) => {
      for (const batch of batches(photoIds, MAX_PHOTOS_PER_ALBUM_REQUEST)) {
        await api.albums.addPhotos(albumId, { photoIds: batch });
      }
    },
    onSettled: (_data, _error, { albumId }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["albums"] }),
        queryClient.invalidateQueries({ queryKey: albumPhotosKey(albumId) }),
      ]),
  });
}

/**
 * Removes photos from an album only; they stay in the library (FR-ALB-2). `beforeCacheUpdate` runs
 * first, so a viewer showing the photo can move on before the photo leaves the cached list.
 */
export function useRemoveFromAlbum(
  albumId: string,
  { beforeCacheUpdate }: { beforeCacheUpdate?: () => Promise<void> | void } = {},
) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (photoIds: string[]) => {
      // No batch route: one request per photo, a few at a time.
      for (const batch of batches(photoIds, 5)) {
        await Promise.all(batch.map((photoId) => api.albums.removePhoto(albumId, photoId)));
      }
    },
    onSuccess: async (_data, photoIds) => {
      await beforeCacheUpdate?.();
      removeFromAlbumCache(queryClient, albumId, photoIds);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["albums"] }),
        queryClient.invalidateQueries({ queryKey: albumPhotosKey(albumId) }),
      ]),
  });
}
