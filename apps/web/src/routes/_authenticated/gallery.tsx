import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Library } from "@/gallery/Library";
import { libraryFilter } from "@/gallery/library";
import { gallerySearchSchema } from "@/gallery/search";
import { galleryQuery } from "@/queries/photos";

export const Route = createFileRoute("/_authenticated/gallery")({
  validateSearch: gallerySearchSchema,
  // The gallery has no album picker any more (user request 2026-11-01): an old link or bookmark
  // to `/gallery?album=` opens that album's own page, which shows the same photos.
  beforeLoad: ({ search: { album, addTo } }) => {
    if (album && !addTo) {
      throw redirect({ to: "/albums/$albumId", params: { albumId: album }, replace: true });
    }
  },
  loaderDeps: ({ search }) => libraryFilter("photo", search),
  // `staleTime: "static"` = use cached pages as they are (the replacement for the deprecated
  // ensureInfiniteQueryData); the component's query refetches stale data in the background.
  loader: ({ context, deps }) =>
    context.queryClient.infiniteQuery({ ...galleryQuery(context.api, deps), staleTime: "static" }),
  component: Gallery,
  errorComponent: GalleryError,
});

/** Photos only (FR-VID-11): videos have their own section (`/videos`). */
function Gallery() {
  const { api } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  return (
    <Library
      kind="photo"
      api={api}
      search={Route.useSearch()}
      setSearch={(change) => void navigate({ search: change })}
    />
  );
}

// e.g. an album that was deleted or is no longer shared, a place without photos (404), or no network.
function GalleryError({ error }: ErrorComponentProps) {
  const { album, place } = Route.useSearch();
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      {album || place ? (
        <Button asChild variant="outline">
          <Link to="/gallery" search={(prev) => ({ ...prev, album: undefined, place: undefined })}>
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
