import type { Photo, PhotoPage, PhotoSort } from "@photo-app/shared";
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Api } from "@/api/api";
import { ApiRequestError } from "@/api/errors";
import { batches } from "./albums";
import { signedUrlRefreshInterval } from "./signedUrls";

export interface GalleryFilter {
  album?: string | undefined;
  sort: PhotoSort;
}

/** How often the gallery refetches while photos are processing (§5 step 5, FR-GAL-5). */
export const PROCESSING_POLL_MS = 3000;
/**
 * Processing takes seconds (6.10); a photo still pending after this long is an abandoned upload
 * (swept by 6.11), so it no longer keeps the gallery polling.
 */
export const PROCESSING_WINDOW_MS = 10 * 60 * 1000;

const isProcessing = (photo: Photo, now: number) =>
  photo.status === "pending" && now - Date.parse(photo.uploadedAt) < PROCESSING_WINDOW_MS;

/** Poll interval for the loaded pages: on while a recent upload is still processing. */
export function processingPollInterval(
  data: InfiniteData<PhotoPage> | undefined,
  now = Date.now(),
): number | false {
  const processing = data?.pages.some((page) => page.items.some((p) => isProcessing(p, now)));
  return processing ? PROCESSING_POLL_MS : false;
}

/**
 * The gallery's photo list, page by page with the API cursor (§12.2, FR-GAL-1/2). With an album
 * it lists that album, which the API returns in upload order (§9), so `sort` doesn't apply and
 * isn't part of the key. Everything sits under ["photos"] for invalidation after uploads/deletes.
 */
export const galleryQuery = (api: Api, { album, sort }: GalleryFilter) =>
  infiniteQueryOptions({
    queryKey: album ? ["photos", { album }] : ["photos", { sort }],
    // `?? undefined`: a list restored from the saved cache (9.3) has `null` for the first page,
    // since JSON can't store `undefined`; sent as `?cursor=null`, the API answers 400.
    queryFn: ({ pageParam, signal }) =>
      album
        ? api.albums.photos(album, { cursor: pageParam ?? undefined }, { signal })
        : api.photos.list({ sort, cursor: pageParam ?? undefined }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Refetches every loaded page, so a finished photo gets its size, thumbnail and date position,
    // and a shared album's signed URLs are renewed before they expire.
    refetchInterval: ({ state: { data } }) =>
      processingPollInterval(data) ||
      signedUrlRefreshInterval(
        data?.pages.flatMap((page) => page.items.flatMap((p) => [p.thumbUrl, p.previewUrl])) ?? [],
      ),
  });

const photoKey = (photoId: string) => ["photos", "one", photoId] as const;

/**
 * One photo (`GET /photos/{id}`): for a viewer opened outside the loaded pages, and for a shared
 * album's photo, whose preview URL the album pages leave out (7.4). `album` is needed for photos
 * of albums shared with me and ignored for own ones.
 */
export const photoQuery = (api: Api, photoId: string, album?: string) =>
  queryOptions({
    queryKey: [...photoKey(photoId), { album }],
    queryFn: ({ signal }) => api.photos.get(photoId, album, { signal }),
    // A shared photo's URLs are signed for 15 min.
    refetchInterval: ({ state: { data } }) =>
      signedUrlRefreshInterval([data?.thumbUrl ?? null, data?.previewUrl ?? null]),
  });

/** A ready photo listed without a preview URL: a shared album's, to be fetched on its own (7.4). */
export const needsOwnFetch = (photo: Photo | undefined) =>
  photo?.status === "ready" && !photo.previewUrl;

/**
 * After an upload reached S3 (8.10): the photo now exists as `pending`, so the gallery shows it as
 * processing (and polls until ready), and usage counts it (5.6b).
 */
export const refreshAfterUpload = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["photos"] }),
    queryClient.invalidateQueries({ queryKey: ["me"] }),
  ]);

/** Drops a deleted photo from every cached list and its own entry, before the refetch confirms. */
export function removePhotoFromCache(queryClient: QueryClient, photoId: string) {
  queryClient.removeQueries({ queryKey: photoKey(photoId) });
  queryClient.setQueriesData<InfiniteData<PhotoPage>>({ queryKey: ["photos"] }, (data) =>
    data?.pages
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((p) => p.photoId !== photoId),
          })),
        }
      : data,
  );
}

export interface DeletePhotosResult {
  /** Deleted now, or already gone (404). */
  deleted: string[];
  /** Still there, with the first error to show. */
  failed: string[];
  error?: unknown;
}

/**
 * Deletes several own photos (FR-DEL-1) from the gallery's select mode. No batch route: one
 * `DELETE /photos/{id}` per photo, a few at a time. A failed photo doesn't stop the others; the
 * result says which ones are left, so they can be tried again.
 */
export function useDeletePhotos() {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (photoIds: string[]): Promise<DeletePhotosResult> => {
      const result: DeletePhotosResult = { deleted: [], failed: [] };
      for (const batch of batches(photoIds, 5)) {
        const settled = await Promise.allSettled(batch.map((id) => api.photos.delete(id)));
        settled.forEach((outcome, i) => {
          const photoId = batch[i]!;
          const gone =
            outcome.status === "fulfilled" ||
            (outcome.reason instanceof ApiRequestError && outcome.reason.code === "NOT_FOUND");
          if (gone) {
            result.deleted.push(photoId);
          } else {
            result.failed.push(photoId);
            result.error ??= outcome.reason;
          }
        });
      }
      return result;
    },
    onSuccess: ({ deleted }) => {
      for (const photoId of deleted) removePhotoFromCache(queryClient, photoId);
    },
    onSettled: () =>
      Promise.all(
        [["photos"], ["albums"], ["me"]].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}
