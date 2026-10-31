import type { Album } from "@photo-app/shared";
import {
  useInfiniteQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { ChevronLeft, Ellipsis, ImagePlus, LogOut, Pencil, Share2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  DeleteAlbumDialog,
  LeaveSharedAlbumDialog,
  RenameAlbumDialog,
} from "@/albums/AlbumDialogs";
import { ShareDialog } from "@/albums/ShareDialog";
import { sharedBy } from "@/albums/sharedBy";
import { ApiRequestError, errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PhotoGrid } from "@/gallery/PhotoGrid";
import type { GallerySearch } from "@/gallery/search";
import { SelectButton } from "@/gallery/SelectButton";
import { SelectionBar } from "@/gallery/SelectionBar";
import { useSelection } from "@/gallery/useSelection";
import { albumsQuery, useRemoveFromAlbum, useUpdateAlbum } from "@/queries/albums";
import { galleryQuery } from "@/queries/photos";
import { saveSummary, sharedAlbumsQuery, useSaveSharedPhotos } from "@/queries/shares";

// Album photos newest taken first, in month sections like the gallery (§12.3).
const listOf = (albumId: string): GallerySearch => ({ album: albumId, sort: "taken-desc" });

// Album view (FR-ALB-1/2, 8.11): the album's photos, add/remove, rename, cover, delete, share
// (FR-SHR-1/2, 8.12). Albums shared with me open read-only (FR-SHR-4).
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
  // Not mine, yet the loader could list its photos: shared with me (an unknown or revoked album
  // is a 404 there, AlbumError). The API decides access; this only picks the read-only view.
  if (!album) return <SharedAlbumView key={albumId} albumId={albumId} />;
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
  const [dialog, setDialog] = useState<"rename" | "delete" | "share" | null>(null);
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
        {/* On a phone the name gets its own row: next to the buttons it was squeezed to nothing. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{album.name}</h1>
            <p className="text-sm text-muted-foreground tabular-nums">
              {album.photoCount === 1 ? "1 photo" : `${album.photoCount} photos`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(photos.length > 0 || selection.active) && (
              <SelectButton
                active={selection.active}
                onSelect={() => {
                  setStatus(null);
                  selection.start();
                }}
                onUnselect={selection.stop}
              />
            )}
            <Button asChild>
              <Link to="/gallery" search={{ addTo: album.albumId }}>
                <ImagePlus aria-hidden />
                <span className="sr-only sm:not-sr-only">Add photos</span>
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setDialog("share")}>
              <Share2 aria-hidden />
              <span className="sr-only sm:not-sr-only">Share</span>
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
          months
          selection={selection.grid}
          onSelectionChange={(photoIds) => {
            setStatus(null);
            selection.replace(photoIds);
          }}
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

      <ShareDialog
        album={album}
        open={dialog === "share"}
        onOpenChange={(open) => setDialog(open ? "share" : null)}
      />
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

/**
 * An album someone shared with me (FR-SHR-3/4): view and download only, save photos to my
 * gallery (FR-SHR-10, select mode), or remove it from my albums (FR-SHR-7). Its name and owner come from `GET /shared-albums` (there is no single-album
 * route), paged through until it turns up.
 */
function SharedAlbumView({ albumId }: { albumId: string }) {
  const { api } = Route.useRouteContext();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const search = listOf(albumId);
  const { data: photoPages, ...photos } = useSuspenseInfiniteQuery(galleryQuery(api, search));
  const shared = useInfiniteQuery(sharedAlbumsQuery(api));
  const album = shared.data?.pages.flatMap((page) => page.items).find((a) => a.albumId === albumId);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = shared;
  useEffect(() => {
    if (!album && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [album, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const searching = !album && (shared.isPending || hasNextPage);
  const items = useMemo(() => photoPages.pages.flatMap((page) => page.items), [photoPages]);

  const selection = useSelection();
  const save = useSaveSharedPhotos(albumId);
  const [status, setStatus] = useState<string | null>(null);
  const saveSelected = () =>
    save.mutate(selection.ids, {
      onSuccess: (results) => {
        setStatus(saveSummary(results));
        selection.stop();
      },
    });

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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {album?.name ?? (searching ? "\u00a0" : "Shared album")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {album ? sharedBy(album) : "Shared with you"} · view only
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(items.length > 0 || selection.active) && (
              <SelectButton
                active={selection.active}
                onSelect={() => {
                  setStatus(null);
                  save.reset();
                  selection.start();
                }}
                onUnselect={selection.stop}
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Album actions">
                  <Ellipsis aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setLeaving(true)}>
                  <LogOut aria-hidden />
                  Remove from my albums
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {status && (
          <p role="status" className="text-sm text-muted-foreground">
            {status}
          </p>
        )}
      </header>
      {items.length === 0 ? (
        <p className="py-24 text-center text-muted-foreground">This album has no photos yet.</p>
      ) : (
        <PhotoGrid
          photos={items}
          hasNextPage={photos.hasNextPage && !photos.isFetchNextPageError}
          isFetchingNextPage={photos.isFetchingNextPage}
          fetchNextPage={photos.fetchNextPage}
          viewerSearch={search}
          months
          selection={selection.grid}
          onSelectionChange={(photoIds) => {
            setStatus(null);
            selection.replace(photoIds);
          }}
        />
      )}
      {photos.isFetchNextPageError && (
        <div role="alert" className="flex items-center justify-center gap-3 py-4 text-sm">
          <span className="text-muted-foreground">More photos couldn't be loaded.</span>
          <Button variant="outline" size="sm" onClick={() => void photos.fetchNextPage()}>
            Try again
          </Button>
        </div>
      )}
      {selection.active && (
        <SelectionBar count={selection.selected.size} onCancel={selection.stop}>
          {save.isError ? (
            <span role="alert" className="text-sm text-destructive">
              {errorMessage(save.error)}
            </span>
          ) : null}
          <Button disabled={selection.selected.size === 0 || save.isPending} onClick={saveSelected}>
            <ImagePlus aria-hidden />
            {save.isPending ? "Saving…" : "Save to my gallery"}
          </Button>
        </SelectionBar>
      )}
      <LeaveSharedAlbumDialog
        albumId={albumId}
        name={album?.name}
        open={leaving}
        onOpenChange={setLeaving}
        onLeft={() => navigate({ to: "/albums", replace: true })}
      />
    </main>
  );
}

// 404 from the album's photo list: unknown, deleted, or no longer shared with me. Or no network.
function AlbumError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const notFound = error instanceof ApiRequestError && error.status === 404;
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">
        {notFound ? "Album not found" : "Album"}
      </h1>
      <p className="text-muted-foreground">
        {notFound
          ? "This album doesn't exist, was deleted, or is no longer shared with you."
          : errorMessage(error)}
      </p>
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
