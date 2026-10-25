import type { Album } from "@photo-app/shared";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { ChevronLeft, Ellipsis, ImagePlus, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { DeleteAlbumDialog, RenameAlbumDialog } from "@/albums/AlbumDialogs";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PhotoGrid } from "@/gallery/PhotoGrid";
import type { GallerySearch } from "@/gallery/search";
import { SelectionBar } from "@/gallery/SelectionBar";
import { useSelection } from "@/gallery/useSelection";
import { albumsQuery, useRemoveFromAlbum, useUpdateAlbum } from "@/queries/albums";
import { galleryQuery } from "@/queries/photos";

// Album photos are listed in upload order (§9), so sort doesn't apply.
const listOf = (albumId: string): GallerySearch => ({ album: albumId, sort: "taken-desc" });

// Album view (FR-ALB-1/2, 8.11): the album's photos, add/remove, rename, cover, delete.
export const Route = createFileRoute("/_authenticated/albums/$albumId")({
  loader: ({ context: { queryClient, api }, params: { albumId } }) =>
    Promise.all([
      queryClient.query({ ...albumsQuery(api), staleTime: "static" }),
      queryClient.infiniteQuery({ ...galleryQuery(api, listOf(albumId)), staleTime: "static" }),
    ]),
  component: AlbumPage,
  errorComponent: AlbumError,
});

function AlbumPage() {
  const { api } = Route.useRouteContext();
  const { albumId } = Route.useParams();
  const { data: albums } = useSuspenseQuery(albumsQuery(api));
  const album = albums.items.find((a) => a.albumId === albumId);
  // Albums shared with me get their own view in 8.12; until then only my own open here.
  if (!album) return <NotFound />;
  return <AlbumView key={albumId} album={album} />;
}

function AlbumView({ album }: { album: Album }) {
  const { api } = Route.useRouteContext();
  const navigate = useNavigate();
  const search = listOf(album.albumId);
  const { data, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    useSuspenseInfiniteQuery(galleryQuery(api, search));
  const photos = useMemo(() => data.pages.flatMap((page) => page.items), [data]);

  const selection = useSelection();
  const remove = useRemoveFromAlbum(album.albumId);
  const cover = useUpdateAlbum(album.albumId);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const removeSelected = () =>
    remove.mutate(selection.ids, {
      onSuccess: () => {
        setStatus(
          selection.ids.length === 1
            ? "1 photo removed from the album."
            : `${selection.ids.length} photos removed from the album.`,
        );
        selection.stop();
      },
    });

  const setCover = () =>
    cover.mutate(
      { coverPhotoId: selection.ids[0]! },
      {
        onSuccess: () => {
          setStatus("Album cover updated.");
          selection.stop();
        },
      },
    );

  const error = remove.error ?? cover.error;

  return (
    <main className="space-y-5">
      <header className="space-y-3">
        <Link
          to="/albums"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Albums
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{album.name}</h1>
            <p className="text-sm text-muted-foreground tabular-nums">
              {album.photoCount === 1 ? "1 photo" : `${album.photoCount} photos`}
            </p>
          </div>
          {!selection.active && (
            <div className="flex items-center gap-2">
              {photos.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setStatus(null);
                    selection.start();
                  }}
                >
                  Select
                </Button>
              )}
              <Button asChild>
                <Link to="/gallery" search={{ addTo: album.albumId }}>
                  <ImagePlus aria-hidden />
                  Add photos
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Album actions">
                    <Ellipsis aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog("rename")}>
                    <Pencil aria-hidden />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
                    <Trash2 aria-hidden />
                    Delete album
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        {status && (
          <p role="status" className="text-sm text-muted-foreground">
            {status}
          </p>
        )}
      </header>

      {photos.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <p className="text-muted-foreground">This album has no photos yet.</p>
          <Button asChild variant="outline">
            <Link to="/gallery" search={{ addTo: album.albumId }}>
              Add photos
            </Link>
          </Button>
        </div>
      ) : (
        <PhotoGrid
          photos={photos}
          hasNextPage={hasNextPage && !isFetchNextPageError}
          isFetchingNextPage={isFetchingNextPage}
          fetchNextPage={fetchNextPage}
          viewerSearch={search}
          selection={selection.grid}
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

      {selection.active && (
        <SelectionBar count={selection.selected.size} onCancel={selection.stop}>
          {error ? (
            <span role="alert" className="text-sm text-destructive">
              {errorMessage(error)}
            </span>
          ) : null}
          {selection.selected.size === 1 && (
            <Button variant="outline" disabled={cover.isPending} onClick={setCover}>
              Set as cover
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={selection.selected.size === 0 || remove.isPending}
            onClick={removeSelected}
          >
            {remove.isPending ? "Removing…" : "Remove from album"}
          </Button>
        </SelectionBar>
      )}

      <RenameAlbumDialog
        album={album}
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
      />
      <DeleteAlbumDialog
        album={album}
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        onDeleted={() => navigate({ to: "/albums", replace: true })}
      />
    </main>
  );
}

function NotFound() {
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Album not found</h1>
      <p className="text-muted-foreground">This album doesn't exist or was deleted.</p>
      <Button asChild variant="outline">
        <Link to="/albums">Back to albums</Link>
      </Button>
    </main>
  );
}

// e.g. a deleted album (404 from its photo list), or no network.
function AlbumError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Album</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <div className="flex gap-2">
        <Button asChild variant="outline">
          <Link to="/albums">Back to albums</Link>
        </Button>
        <Button variant="ghost" onClick={() => void router.invalidate()}>
          Try again
        </Button>
      </div>
    </main>
  );
}
