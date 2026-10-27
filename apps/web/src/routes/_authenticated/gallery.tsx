import { photoSortSchema, type PhotoSort } from "@photo-app/shared";
import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { MapPin, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { AddToAlbumDialog } from "@/albums/AddToAlbumDialog";
import { errorMessage } from "@/api/errors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhotoGrid } from "@/gallery/PhotoGrid";
import { PlaceSearch } from "@/gallery/PlaceSearch";
import { gallerySearchSchema } from "@/gallery/search";
import { SelectButton } from "@/gallery/SelectButton";
import { SelectionBar } from "@/gallery/SelectionBar";
import { useSelection } from "@/gallery/useSelection";
import { albumsQuery, useAddToAlbum } from "@/queries/albums";
import { galleryQuery, useDeletePhotos } from "@/queries/photos";
import { placesQuery } from "@/queries/places";
import { GalleryUploads } from "@/upload/GalleryUploads";
import { useUploads } from "@/upload/useUploads";

export const Route = createFileRoute("/_authenticated/gallery")({
  validateSearch: gallerySearchSchema,
  loaderDeps: ({ search: { album, place, sort } }) => ({ album, place, sort }),
  // `staleTime: "static"` = use cached pages as they are (the replacement for the deprecated
  // ensureInfiniteQueryData); the component's query refetches stale data in the background.
  loader: ({ context, deps }) =>
    context.queryClient.infiniteQuery({ ...galleryQuery(context.api, deps), staleTime: "static" }),
  component: Gallery,
  errorComponent: GalleryError,
});

function Gallery() {
  const { api } = Route.useRouteContext();
  const { album, place, sort, addTo } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    useSuspenseInfiniteQuery(galleryQuery(api, { album, place, sort }));
  const photos = useMemo(() => data.pages.flatMap((page) => page.items), [data]);
  // Not-yet-uploaded files (FR-UP-6); uploads go to all photos, not to the album or place viewed.
  const entries = useUploads();
  const uploads = useMemo(
    () => (album || place || addTo ? [] : entries.filter((entry) => entry.status !== "done")),
    [album, place, addTo, entries],
  );

  const selection = useSelection({ forced: addTo !== undefined });
  const [status, setStatus] = useState<ReactNode>(null);
  // In an album that isn't in my list (shared with me) the photos belong to someone else.
  const { data: albums } = useQuery({ ...albumsQuery(api), enabled: album !== undefined });
  const own = album === undefined || !!albums?.items.some((a) => a.albumId === album);

  return (
    <main className="space-y-5">
      {addTo ? (
        <AddToHeader albumId={addTo} />
      ) : (
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
          <PlaceSearch
            api={api}
            className="order-last w-full md:order-none md:w-64"
            // A place replaces an album filter (they don't combine).
            onPick={(picked) =>
              void navigate({
                search: (prev) => ({ ...prev, album: undefined, place: picked.placeId }),
              })
            }
          />
          <div className="flex flex-wrap gap-2">
            <GalleryFilters album={album} sort={sort} />
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
          </div>
        </header>
      )}
      {place && !addTo && <PlaceFilter placeId={place} />}
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      {uploads.length > 0 && <GalleryUploads entries={uploads} />}
      {photos.length === 0 ? (
        uploads.length === 0 && (
          <EmptyGallery inAlbum={album !== undefined || place !== undefined} />
        )
      ) : (
        <PhotoGrid
          photos={photos}
          hasNextPage={hasNextPage && !isFetchNextPageError}
          isFetchingNextPage={isFetchingNextPage}
          fetchNextPage={fetchNextPage}
          selection={selection.grid}
          onSelectionChange={(photoIds) => {
            setStatus(null);
            selection.replace(photoIds);
          }}
          months
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
      {selection.active &&
        (addTo ? (
          <AddToBar albumId={addTo} photoIds={selection.ids} />
        ) : (
          <SelectionActions
            photoIds={selection.ids}
            own={own}
            onCancel={selection.stop}
            onDeleted={selection.drop}
            onDone={(message) => {
              setStatus(message);
              selection.stop();
            }}
          />
        ))}
    </main>
  );
}

const photosText = (count: number) => (count === 1 ? "1 photo" : `${count} photos`);

/**
 * Select mode in the gallery (8.11): add the picked photos to an album (FR-ALB-2), or delete them
 * (FR-DEL-1/2, own photos only).
 */
function SelectionActions({
  photoIds,
  own,
  onCancel,
  onDeleted,
  onDone,
}: {
  photoIds: string[];
  own: boolean;
  onCancel: () => void;
  /** Some photos were deleted, others failed: those stay picked for another try. */
  onDeleted: (photoIds: string[]) => void;
  onDone: (message: ReactNode) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <SelectionBar count={photoIds.length} onCancel={onCancel}>
      {own && <DeleteSelected photoIds={photoIds} onDeleted={onDeleted} onDone={onDone} />}
      <Button disabled={photoIds.length === 0} onClick={() => setChoosing(true)}>
        Add to album
      </Button>
      <AddToAlbumDialog
        photoIds={photoIds}
        open={choosing}
        onOpenChange={setChoosing}
        onAdded={(album) =>
          onDone(
            <>
              Added {photosText(photoIds.length)} to{" "}
              <Link
                to="/albums/$albumId"
                params={{ albumId: album.albumId }}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {album.name}
              </Link>
              .
            </>,
          )
        }
      />
    </SelectionBar>
  );
}

/** Deletes the picked photos after a confirmation (FR-DEL-2); failed ones stay picked. */
function DeleteSelected({
  photoIds,
  onDeleted,
  onDone,
}: {
  photoIds: string[];
  onDeleted: (photoIds: string[]) => void;
  onDone: (message: ReactNode) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Across tries, for the final message.
  const [deletedBefore, setDeletedBefore] = useState(0);
  const remove = useDeletePhotos();
  const count = photosText(photoIds.length);
  const partial = remove.data && remove.data.failed.length > 0 ? remove.data : undefined;

  return (
    <AlertDialog
      open={confirming}
      onOpenChange={(open) => {
        if (remove.isPending) return;
        setConfirming(open);
        if (!open) {
          remove.reset();
          setDeletedBefore(0);
        }
      }}
    >
      <Button
        variant="destructive"
        disabled={photoIds.length === 0}
        onClick={() => setConfirming(true)}
      >
        Delete
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {photoIds.length === 1 ? "Delete this photo?" : `Delete ${count}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {photoIds.length === 1 ? "It" : "They"} will be removed from your library and from all
            albums. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {(remove.isError || partial) && (
          <p role="alert" className="text-sm text-destructive">
            {partial
              ? `${photosText(partial.failed.length)} couldn't be deleted: ${errorMessage(partial.error)}`
              : errorMessage(remove.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending || photoIds.length === 0}
            onClick={(event) => {
              event.preventDefault(); // stay open until the API answers
              remove.mutate(photoIds, {
                onSuccess: ({ deleted, failed }) => {
                  if (failed.length > 0) {
                    setDeletedBefore((n) => n + deleted.length);
                    onDeleted(deleted);
                    return;
                  }
                  setConfirming(false);
                  onDone(`Deleted ${photosText(deletedBefore + deleted.length)}.`);
                },
              });
            }}
          >
            {remove.isPending ? "Deleting…" : partial ? "Try again" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddToHeader({ albumId }: { albumId: string }) {
  const { api } = Route.useRouteContext();
  const { data: albums } = useQuery(albumsQuery(api));
  const name = albums?.items.find((a) => a.albumId === albumId)?.name;
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">
        {name ? `Add to ${name}` : "Add to album"}
      </h1>
      <p className="text-sm text-muted-foreground">Select the photos to add.</p>
    </header>
  );
}

/**
 * Picking photos for an album, opened from its "Add photos" (`?addTo=`): adds them and returns to
 * the album; Cancel just returns.
 */
function AddToBar({ albumId, photoIds }: { albumId: string; photoIds: string[] }) {
  const router = useRouter();
  const add = useAddToAlbum();
  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void router.navigate({ to: "/albums/$albumId", params: { albumId }, replace: true });
  };
  return (
    <SelectionBar count={photoIds.length} onCancel={back}>
      {add.isError && (
        <span role="alert" className="text-sm text-destructive">
          {errorMessage(add.error)}
        </span>
      )}
      <Button
        disabled={photoIds.length === 0 || add.isPending}
        onClick={() => add.mutate({ albumId, photoIds }, { onSuccess: back })}
      >
        {add.isPending
          ? "Adding…"
          : photoIds.length === 0
            ? "Add"
            : `Add ${photosText(photoIds.length)}`}
      </Button>
    </SelectionBar>
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
            search: (prev) => ({
              ...prev,
              album: value === ALL_PHOTOS ? undefined : value,
              place: undefined,
            }),
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
    </div>
  );
}

/** The place the gallery is filtered to (13.2f), with a way back to all photos. */
function PlaceFilter({ placeId }: { placeId: string }) {
  const { api } = Route.useRouteContext();
  const { data } = useQuery(placesQuery(api));
  const place = data?.items.find((p) => p.placeId === placeId);
  return (
    <div className="flex items-center gap-2">
      <MapPin aria-hidden className="size-4 text-muted-foreground" />
      <p className="text-sm">
        <span className="font-medium">{place?.name ?? "Selected place"}</span>
        {place?.context && <span className="text-muted-foreground"> · {place.context}</span>}
      </p>
      <Button asChild variant="ghost" size="icon" className="size-7">
        <Link
          to="/gallery"
          search={(prev) => ({ ...prev, place: undefined })}
          aria-label="Show all photos"
        >
          <X className="size-4" />
        </Link>
      </Button>
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
