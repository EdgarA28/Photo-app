import type { Album } from "@photo-app/shared";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { BookImage, Plus } from "lucide-react";
import { useState } from "react";
import { useImageFailed } from "@/components/useImageFailed";
import { CreateAlbumDialog } from "@/albums/AlbumDialogs";
import { sharedBy } from "@/albums/sharedBy";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { albumsQuery } from "@/queries/albums";
import { sharedAlbumsQuery } from "@/queries/shares";

// My albums (FR-ALB-1, 8.11) and albums shared with me (FR-SHR-3, 8.12).
export const Route = createFileRoute("/_authenticated/albums/")({
  loader: ({ context }) =>
    context.queryClient.query({ ...albumsQuery(context.api), staleTime: "static" }),
  component: Albums,
  errorComponent: AlbumsError,
});

function Albums() {
  const { api } = Route.useRouteContext();
  const { data } = useSuspenseQuery(albumsQuery(api));
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // Newest first: album IDs are ULIDs, so the API lists them oldest first.
  const albums = [...data.items].reverse();

  return (
    <main className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          New album
        </Button>
      </header>

      {albums.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <BookImage aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">No albums yet.</p>
          <Button variant="outline" onClick={() => setCreating(true)}>
            Create your first album
          </Button>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {albums.map((album) => (
            <li key={album.albumId}>
              <AlbumCard album={album} />
            </li>
          ))}
        </ul>
      )}

      <SharedWithMe />

      {/* Straight into the new album, ready to add photos. */}
      <CreateAlbumDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(album) =>
          void navigate({ to: "/albums/$albumId", params: { albumId: album.albumId } })
        }
      />
    </main>
  );
}

/** Albums others shared with me (FR-SHR-3): hidden while there are none. */
function SharedWithMe() {
  const { api } = Route.useRouteContext();
  // Not in the loader: my own albums shouldn't wait for (or fail with) this list.
  const { data, isError, error, refetch, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(sharedAlbumsQuery(api));
  const albums = data?.pages.flatMap((page) => page.items) ?? [];
  if (!isError && albums.length === 0) return null;

  return (
    <section aria-labelledby="shared-with-me" className="space-y-4 border-t pt-6">
      <h2 id="shared-with-me" className="text-lg font-semibold tracking-tight">
        Shared with me
      </h2>
      {isError && albums.length === 0 ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{errorMessage(error)}</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {albums.map((album) => (
            <li key={`${album.ownerId}/${album.albumId}`}>
              <AlbumCard album={album} subtitle={sharedBy(album)} />
            </li>
          ))}
        </ul>
      )}
      {hasNextPage && (
        <Button
          variant="outline"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}
    </section>
  );
}

function AlbumCard({ album, subtitle }: { album: Album; subtitle?: string }) {
  const [broken, onError] = useImageFailed(album.coverThumbUrl);
  return (
    <Link
      to="/albums/$albumId"
      params={{ albumId: album.albumId }}
      className="group block space-y-2 rounded-lg outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="grid aspect-square place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
        {album.coverThumbUrl && !broken ? (
          <img
            src={album.coverThumbUrl}
            alt=""
            loading="lazy"
            onError={onError}
            className="size-full object-cover transition-transform group-hover:scale-[1.02]"
          />
        ) : (
          <BookImage aria-hidden className="size-8" />
        )}
      </div>
      <div>
        <p className="truncate text-sm font-medium">{album.name}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {album.photoCount === 1 ? "1 photo" : `${album.photoCount} photos`}
        </p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
    </Link>
  );
}

function AlbumsError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </main>
  );
}
