import { photoSortSchema, type PhotoSort } from "@photo-app/shared";
import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useMemo } from "react";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhotoGrid } from "@/gallery/PhotoGrid";
import { gallerySearchSchema } from "@/gallery/search";
import { albumsQuery } from "@/queries/albums";
import { galleryQuery } from "@/queries/photos";

export const Route = createFileRoute("/_authenticated/gallery")({
  validateSearch: gallerySearchSchema,
  loaderDeps: ({ search: { album, sort } }) => ({ album, sort }),
  // `staleTime: "static"` = use cached pages as they are (the replacement for the deprecated
  // ensureInfiniteQueryData); the component's query refetches stale data in the background.
  loader: ({ context, deps }) =>
    context.queryClient.infiniteQuery({ ...galleryQuery(context.api, deps), staleTime: "static" }),
  component: Gallery,
  errorComponent: GalleryError,
});

function Gallery() {
  const { api } = Route.useRouteContext();
  const { album, sort } = Route.useSearch();
  const { data, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    useSuspenseInfiniteQuery(galleryQuery(api, { album, sort }));
  const photos = useMemo(() => data.pages.flatMap((page) => page.items), [data]);

  return (
    <main className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
        <GalleryFilters album={album} sort={sort} />
      </header>
      {photos.length === 0 ? (
        <EmptyGallery inAlbum={album !== undefined} />
      ) : (
        <PhotoGrid
          photos={photos}
          hasNextPage={hasNextPage && !isFetchNextPageError}
          isFetchingNextPage={isFetchingNextPage}
          fetchNextPage={fetchNextPage}
        />
      )}
      {isFetchNextPageError && (
        <div role="alert" className="flex items-center justify-center gap-3 py-4 text-sm">
          <span className="text-muted-foreground">More photos couldn't be loaded.</span>
          <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
            Try again
          </Button>
        </div>
      )}
      {isFetchingNextPage && (
        <p role="status" className="py-4 text-center text-sm text-muted-foreground">
          Loading more photos…
        </p>
      )}
    </main>
  );
}

const ALL_PHOTOS = "all";

const SORT_LABELS: Record<PhotoSort, string> = {
  "taken-desc": "Newest first",
  "taken-asc": "Oldest first",
};

function GalleryFilters({ album, sort }: { album: string | undefined; sort: PhotoSort }) {
  const { api } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  // Not in the loader: the photos shouldn't wait for (or fail with) the album list.
  const { data: albums } = useQuery(albumsQuery(api));
  const items = albums?.items ?? [];
  // e.g. an album shared with me, which isn't in my own list.
  const unlisted = album !== undefined && !items.some((a) => a.albumId === album);

  return (
    <div className="flex gap-2">
      <Select
        value={album ?? ALL_PHOTOS}
        onValueChange={(value) =>
          void navigate({
            search: (prev) => ({ ...prev, album: value === ALL_PHOTOS ? undefined : value }),
          })
        }
      >
        <SelectTrigger aria-label="Album" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_PHOTOS}>All photos</SelectItem>
          {items.map((a) => (
            <SelectItem key={a.albumId} value={a.albumId}>
              {a.name}
            </SelectItem>
          ))}
          {unlisted && <SelectItem value={album}>Selected album</SelectItem>}
        </SelectContent>
      </Select>
      {/* Albums list in the order photos were added (API, §9): sorting doesn't apply there. */}
      {album === undefined && (
        <Select
          value={sort}
          onValueChange={(value) =>
            void navigate({ search: (prev) => ({ ...prev, sort: value as PhotoSort }) })
          }
        >
          <SelectTrigger aria-label="Sort order" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {photoSortSchema.options.map((value) => (
              <SelectItem key={value} value={value}>
                {SORT_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function EmptyGallery({ inAlbum }: { inAlbum: boolean }) {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <p className="text-muted-foreground">
        {inAlbum ? "This album has no photos yet." : "No photos yet."}
      </p>
      {!inAlbum && (
        <Button asChild>
          <Link to="/upload">Upload photos</Link>
        </Button>
      )}
    </div>
  );
}

// e.g. an album that was deleted or is no longer shared (404), or no network.
function GalleryError({ error }: ErrorComponentProps) {
  const { album } = Route.useSearch();
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      {album ? (
        <Button asChild variant="outline">
          <Link to="/gallery" search={(prev) => ({ ...prev, album: undefined })}>
            Show all photos
          </Link>
        </Button>
      ) : (
        <Button variant="outline" onClick={() => void router.invalidate()}>
          Try again
        </Button>
      )}
    </main>
  );
}
