import type { PhotoSort } from "@photo-app/shared";
import { infiniteQueryOptions } from "@tanstack/react-query";
import type { Api } from "@/api/api";

export interface GalleryFilter {
  album?: string | undefined;
  sort: PhotoSort;
}

/**
 * The gallery's photo list, page by page with the API cursor (§12.2, FR-GAL-1/2). With an album
 * it lists that album, which the API returns in upload order (§9), so `sort` doesn't apply and
 * isn't part of the key. Everything sits under ["photos"] for invalidation after uploads/deletes.
 */
export const galleryQuery = (api: Api, { album, sort }: GalleryFilter) =>
  infiniteQueryOptions({
    queryKey: album ? ["photos", { album }] : ["photos", { sort }],
    queryFn: ({ pageParam, signal }) =>
      album
        ? api.albums.photos(album, { cursor: pageParam }, { signal })
        : api.photos.list({ sort, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
