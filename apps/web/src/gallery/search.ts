import { photoSortSchema, placeIdSchema, ULID_REGEX } from "@photo-app/shared";
import { z } from "zod";

// §12.1: `album` filters to one album, `place` to one of the user's places (13.2), `sort` orders by
// date taken (FR-GAL-1/2/3). Album and place don't combine: setting one clears the other. Invalid values
// from a hand-edited or stale URL fall back to the defaults instead of an error page. The viewer
// takes the same params, so prev/next walk the list it was opened from (FR-GAL-4).
export const gallerySearchSchema = z.object({
  album: z.string().regex(ULID_REGEX).optional().catch(undefined),
  place: placeIdSchema.optional().catch(undefined),
  sort: photoSortSchema.default("taken-desc").catch("taken-desc"),
  /** Picking photos to add to this album (8.11, from the album's "Add photos"). */
  addTo: z.string().regex(ULID_REGEX).optional().catch(undefined),
});

export type GallerySearch = z.infer<typeof gallerySearchSchema>;
