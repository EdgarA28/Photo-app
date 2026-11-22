import type { GalleryFilter } from "@/queries/photos";
import type { GallerySearch } from "./search";

/** What a library page lists and how it talks about it (FR-VID-11). */
export type LibraryKind = "photo" | "video";

/** The list behind a library page: the Gallery (photos, also in a place) or Videos. */
export const libraryFilter = (kind: LibraryKind, search: GallerySearch): GalleryFilter =>
  kind === "video"
    ? { sort: search.sort, mediaType: "video", start: search.from }
    : {
        album: search.album,
        place: search.place,
        sort: search.sort,
        mediaType: "photo",
        // A jump applies to the whole Gallery only, not to a place's photos.
        start: search.place ? undefined : search.from,
      };
