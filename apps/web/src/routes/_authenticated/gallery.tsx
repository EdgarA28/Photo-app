import { photoSortSchema, ULID_REGEX } from "@photo-app/shared";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// §12.1: `album` filters to one album, `sort` orders by date taken (FR-GAL-1/2). Invalid values
// from a hand-edited or stale URL fall back to the defaults instead of an error page.
const gallerySearchSchema = z.object({
  album: z.string().regex(ULID_REGEX).optional().catch(undefined),
  sort: photoSortSchema.default("taken-desc").catch("taken-desc"),
});

export const Route = createFileRoute("/_authenticated/gallery")({
  validateSearch: gallerySearchSchema,
  component: Gallery,
});

function Gallery() {
  const { album, sort } = Route.useSearch();
  return (
    <main>
      <h1>Gallery</h1>
      <p>
        Sort: {sort}
        {album ? ` · album ${album}` : ""}
      </p>
    </main>
  );
}
