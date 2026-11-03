import type { MediaType, Photo, PhotoPage, PhotoSort } from "@photo-app/shared";
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
  place?: string | undefined;
  sort: PhotoSort;
  /**
   * FR-VID-11: own photos (the Gallery, also when unset) or videos (the Videos section); in a
   * place, unset = both (the map's list). Albums always hold both.
   */
  mediaType?: MediaType | undefined;
}

/** How often the gallery refetches while photos are processing (§5 step 5, FR-GAL-5). */
export const PROCESSING_POLL_MS = 3000;
/**
 * Processing takes seconds (6.10); a photo still pending after this long is an abandoned upload
 * (swept by 6.11), so it no longer keeps the gallery polling.
 */
export const PROCESSING_WINDOW_MS = 10 * 60 * 1000;

/**
 * While uploads are running (13.1j): how often the loaded pages are refetched instead, whether or
 * not they hold a photo still processing. The refreshes after each upload only mark the lists
 * stale then, so an hours-long batch makes a few calls a minute instead of one per page every
 * few seconds; the batch's last refresh refetches at once.
 */
export const BATCH_POLL_MS = 15_000;

let uploadsRunning: () => boolean = () => false;

/** Tells the photo lists whether uploads are running (13.1j); set once by the app. */
export function setUploadsRunning(check: () => boolean) {
  uploadsRunning = check;
}

/** Whether uploads are running, here or in another tab (13.1j). */
export const areUploadsRunning = () => uploadsRunning();

const isProcessing = (photo: Photo, now: number) =>
  photo.status === "pending" && now - Date.parse(photo.uploadedAt) < PROCESSING_WINDOW_MS;

/**
 * The photos of loaded pages that are shown: processed ones only (ready, or failed so the user
 * sees what went wrong). An upload still processing stays hidden until it is ready, instead of a
 * placeholder (user request 2026-11-01, FR-GAL-5); `processingPollInterval` keeps polling for it.
 */
export function shownPhotos<T extends { status: string }>(pages: readonly { items: T[] }[]): T[] {
  return pages.flatMap((page) => page.items.filter((photo) => photo.status !== "pending"));
}

/**
 * Recent uploads of the loaded pages still processing: hidden (`shownPhotos`), so select mode
 * can't pick them. A delete mentions them, or they look like they came back once ready (dev
 * 2026-11-01: 6 of 530 were still processing when the rest was deleted, FR-DEL-1).
 */
export function processingCount(pages: readonly { items: Photo[] }[], now = Date.now()): number {
  return pages.reduce((n, page) => n + page.items.filter((p) => isProcessing(p, now)).length, 0);
}

/**
 * Poll interval for the loaded pages: every `BATCH_POLL_MS` while uploads are running (13.1j),
 * else every `PROCESSING_POLL_MS` while a recent upload is still processing.
 */
export function processingPollInterval(
  data: InfiniteData<PhotoPage> | undefined,
  now = Date.now(),
  running = areUploadsRunning(),
): number | false {
  if (running) return BATCH_POLL_MS;
  const processing = data?.pages.some((page) => page.items.some((p) => isProcessing(p, now)));
  return processing ? PROCESSING_POLL_MS : false;
}

/**
 * The gallery's photo list, page by page with the API cursor (§12.2, FR-GAL-1/2). With an album
 * it lists that album, with a place that place's photos (13.2); all sorted by date taken (§9,
 * §12.3). Everything sits under ["photos"] for invalidation after uploads/deletes.
 */
export const galleryQuery = (api: Api, { album, place, sort, mediaType }: GalleryFilter) =>
  infiniteQueryOptions({
    queryKey: album
      ? ["photos", { album, sort }]
      : place
        ? ["photos", { place, sort, ...(mediaType && { mediaType }) }]
        : mediaType === "video"
          ? ["photos", { sort, mediaType }]
          : ["photos", { sort }],
    // `?? undefined`: a list restored from the saved cache (9.3) has `null` for the first page,
    // since JSON can't store `undefined`; sent as `?cursor=null`, the API answers 400.
    queryFn: ({ pageParam, signal }) =>
      album
        ? api.albums.photos(album, { sort, cursor: pageParam ?? undefined }, { signal })
        : place
          ? api.places.photos(
              place,
              { sort, cursor: pageParam ?? undefined, ...(mediaType && { mediaType }) },
              { signal },
            )
          : api.photos.list(
              {
                sort,
                cursor: pageParam ?? undefined,
                ...(mediaType === "video" && { mediaType }),
              },
              { signal },
            ),
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
 * After an upload reached S3 (8.10): the photo now exists as `pending`, so the gallery polls
 * until it is ready, and usage counts it (5.6b). With `more` uploads still going (13.1j) the
 * lists and usage are only marked stale: the gallery's batch poll (`BATCH_POLL_MS`) and the next
 * visit pick the changes up, and the last upload's refresh refetches what is on screen.
 */
export const refreshAfterUpload = (queryClient: QueryClient, more = false) => {
  const refetchType = more ? "none" : "active";
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["photos"], refetchType }),
    queryClient.invalidateQueries({ queryKey: ["me"], refetchType }),
  ]);
};

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
 * Moves several own photos to the trash (FR-DEL-1/3) from the gallery's select mode. No batch route: one
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
        [["photos"], ["albums"], ["places"], ["trash"], ["me"]].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}
