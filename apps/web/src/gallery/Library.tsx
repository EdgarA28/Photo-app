import { photoSortSchema, TRASH_RETENTION_DAYS, type PhotoSort } from "@photo-app/shared";
import { useInfiniteQuery, useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { Link2, MapPin, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhotoGrid, type MonthOffset } from "./PhotoGrid";
import { jumpStart } from "./timeline";
import { TimelineScrubber } from "./TimelineScrubber";
import { PlaceSearch } from "./PlaceSearch";
import { libraryFilter, type LibraryKind } from "./library";
import type { GallerySearch } from "./search";
import { SelectButton } from "./SelectButton";
import { SelectionBar } from "./SelectionBar";
import { useHideOnScroll } from "./useHideOnScroll";
import { useSelection } from "./useSelection";
import { ShareLinkDialog } from "@/links/ShareLinkDialog";
import { albumsQuery, useAddToAlbum } from "@/queries/albums";
import { sharedAlbumsQuery } from "@/queries/shares";
import {
  galleryQuery,
  processingCount,
  shownPhotos,
  timelineQuery,
  useDeletePhotos,
} from "@/queries/photos";
import { placesQuery } from "@/queries/places";
import { GalleryUploads } from "@/upload/GalleryUploads";
import { useUploads } from "@/upload/useUploads";
import { mediaTypeOf } from "@/upload/validate";
import type { Api } from "@/api/api";

const NOUN: Record<LibraryKind, { one: string; many: string; page: string }> = {
  photo: { one: "photo", many: "photos", page: "the gallery" },
  video: { one: "video", many: "videos", page: "Videos" },
};

/**
 * The Gallery (`/gallery`, photos) and the Videos section (`/videos`), which keep photos and
 * videos apart (FR-VID-11, user request 2026-11-04): the same page for both. Uploads in progress,
 * sort, month sections, select mode (album, trash, public link), adding to an album (`addTo`);
 * the place search only in the Gallery (the map shows both).
 */
export function Library({
  kind,
  api,
  search,
  setSearch,
}: {
  kind: LibraryKind;
  api: Api;
  search: GallerySearch;
  /** Changes this page's search params (the route's own navigate). */
  setSearch: (change: (prev: GallerySearch) => GallerySearch) => void;
}) {
  const { album, place, addTo } = search;
  const noun = NOUN[kind];
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
    isFetching,
  } = useSuspenseInfiniteQuery(galleryQuery(api, libraryFilter(kind, search)));
  const photos = useMemo(() => shownPhotos(data.pages), [data]);
  const processing = useMemo(() => processingCount(data.pages), [data]);
  // Not-yet-uploaded files (FR-UP-6), each on its own page (photos here, videos in Videos);
  // uploads go to all photos, not to the album or place viewed.
  const entries = useUploads();
  const uploads = useMemo(
    () =>
      album || place || addTo
        ? []
        : entries.filter(
            (entry) => entry.status !== "done" && mediaTypeOf(entry.contentType) === kind,
          ),
    [album, place, addTo, entries, kind],
  );
  // The viewer walks this list (FR-GAL-4): it gets the same filter.
  const viewerSearch: GallerySearch = { ...search, mediaType: kind };

  const selection = useSelection({ forced: addTo !== undefined });
  const [status, setStatus] = useState<ReactNode>(null);
  // In an album that isn't in my list (shared with me) the photos belong to someone else.
  const { data: albums } = useQuery({ ...albumsQuery(api), enabled: album !== undefined });
  const own = album === undefined || !!albums?.items.some((a) => a.albumId === album);
  // Its buttons (Unselect all, the album being added to) stay while they're the way out.
  const headerHidden = useHideOnScroll(!selection.active && !addTo);
  const timeline = useTimeline({ api, kind, search, setSearch, enabled: !place && !addTo });

  return (
    // On a phone the header takes as little room from the photos as it can: tight to the top of the
    // page and to the grid, and out of the way while scrolling down.
    <main
      className={cn(
        "-mt-5 space-y-1 md:mt-0 md:space-y-5",
        // On a computer the timeline scrubber gets its own lane; on a phone it floats over the
        // photos while scrolling, as in Google Photos.
        timeline.months.length > 1 && "md:pr-12",
      )}
    >
      {/* Stays at the top while the photos scroll under it; full width over the page padding. */}
      <div
        data-hidden={headerHidden || undefined}
        className="sticky top-0 z-20 -mx-4 space-y-2 bg-background/95 px-4 py-2 backdrop-blur transition-transform duration-200 max-md:data-hidden:not-focus-within:-translate-y-full md:-mx-8 md:space-y-3 md:px-8 md:py-3"
      >
        {addTo ? (
          <AddToHeader api={api} albumId={addTo} kind={kind} />
        ) : (
          <header className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {kind === "video" ? "Videos" : "Gallery"}
            </h1>
            {kind === "photo" && (
              <PlaceSearch
                api={api}
                className="order-last w-full md:order-none md:w-64"
                // A place replaces an album filter (they don't combine).
                onPick={(picked) =>
                  setSearch((prev) => ({ ...prev, album: undefined, place: picked.placeId }))
                }
              />
            )}
            <div className="flex gap-2">
              <GalleryFilters sort={search.sort} setSearch={setSearch} />
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
        {kind === "photo" && place && !addTo && <PlaceFilter api={api} placeId={place} />}
      </div>
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      {uploads.length > 0 && <GalleryUploads entries={uploads} />}
      {isFetchingPreviousPage && (
        <p role="status" className="py-2 text-center text-sm text-muted-foreground">
          Loading newer {noun.many}…
        </p>
      )}
      {photos.length === 0 ? (
        uploads.length === 0 && (
          <EmptyGallery kind={kind} inAlbum={album !== undefined || place !== undefined} />
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
          viewerSearch={viewerSearch}
          months
          hasPreviousPage={hasPreviousPage}
          isFetchingPreviousPage={isFetchingPreviousPage}
          fetchPreviousPage={fetchPreviousPage}
          isFetching={isFetching}
          onMonthOffsets={timeline.onMonthOffsets}
        />
      )}
      {timeline.months.length > 1 && photos.length > 0 && (
        <TimelineScrubber
          months={timeline.months}
          current={timeline.current}
          onScrub={timeline.scrub}
        />
      )}
      {isFetchNextPageError && (
        <div role="alert" className="flex items-center justify-center gap-3 py-4 text-sm">
          <span className="text-muted-foreground">More {noun.many} couldn't be loaded.</span>
          <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
            Try again
          </Button>
        </div>
      )}
      {isFetchingNextPage && (
        <p role="status" className="py-4 text-center text-sm text-muted-foreground">
          Loading more {noun.many}…
        </p>
      )}
      {selection.active &&
        (addTo ? (
          <AddToBar albumId={addTo} photoIds={selection.ids} kind={kind} />
        ) : (
          <SelectionActions
            kind={kind}
            photoIds={selection.ids}
            own={own}
            processing={processing}
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

const itemsText = (kind: LibraryKind, count: number) =>
  count === 1 ? `1 ${NOUN[kind].one}` : `${count} ${NOUN[kind].many}`;

/** Uploads still processing aren't shown or picked; they appear (not deleted) once ready. */
const stillProcessing = (kind: LibraryKind, count: number) =>
  `${itemsText(kind, count)} still processing ${count === 1 ? "isn't" : "aren't"} included and will appear in ${NOUN[kind].page} when ready.`;

/**
 * Select mode in the gallery (8.11): add the picked photos to an album (FR-ALB-2), delete them
 * (FR-DEL-1/2) or make a public link to them (FR-SHR-8); the last two for own photos only.
 */
function SelectionActions({
  kind,
  photoIds,
  own,
  processing,
  onCancel,
  onDeleted,
  onDone,
}: {
  kind: LibraryKind;
  photoIds: string[];
  own: boolean;
  /** Hidden uploads still processing, which can't be picked (`processingCount`). */
  processing: number;
  onCancel: () => void;
  /** Some photos were deleted, others failed: those stay picked for another try. */
  onDeleted: (photoIds: string[]) => void;
  onDone: (message: ReactNode) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <SelectionBar count={photoIds.length} onCancel={onCancel}>
      {own && (
        <DeleteSelected
          kind={kind}
          photoIds={photoIds}
          processing={processing}
          onDeleted={onDeleted}
          onDone={onDone}
        />
      )}
      {own && (
        <ShareLinkDialog
          photoIds={photoIds}
          trigger={({ open, busy }) => (
            <Button
              variant="outline"
              size="icon"
              aria-label="Share link"
              title="Link anyone can open for 15 minutes"
              disabled={photoIds.length === 0 || busy}
              onClick={open}
            >
              <Link2 aria-hidden />
            </Button>
          )}
        />
      )}
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
              Added {itemsText(kind, photoIds.length)} to{" "}
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

/**
 * Moves the picked photos to the trash after a confirmation (FR-DEL-2/3); failed ones stay picked.
 */
function DeleteSelected({
  kind,
  photoIds,
  processing,
  onDeleted,
  onDone,
}: {
  kind: LibraryKind;
  photoIds: string[];
  processing: number;
  onDeleted: (photoIds: string[]) => void;
  onDone: (message: ReactNode) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Across tries, for the final message.
  const [deletedBefore, setDeletedBefore] = useState(0);
  const remove = useDeletePhotos();
  const count = itemsText(kind, photoIds.length);
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
            {photoIds.length === 1
              ? `Move this ${NOUN[kind].one} to the trash?`
              : `Move ${count} to the trash?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {photoIds.length === 1 ? "It" : "They"} will be removed from your library and from all
            albums, and deleted for good after {TRASH_RETENTION_DAYS} days. Until then you can
            restore {photoIds.length === 1 ? "it" : "them"} from the trash.
            {processing > 0 && <> {stillProcessing(kind, processing)}</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {(remove.isError || partial) && (
          <p role="alert" className="text-sm text-destructive">
            {partial
              ? `${itemsText(kind, partial.failed.length)} couldn't be moved: ${errorMessage(partial.error)}`
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
                  onDone(
                    <>
                      Moved {itemsText(kind, deletedBefore + deleted.length)} to the{" "}
                      <Link
                        to="/trash"
                        className="font-medium text-foreground underline underline-offset-4"
                      >
                        trash
                      </Link>
                      .{processing > 0 && <> {stillProcessing(kind, processing)}</>}
                    </>,
                  );
                },
              });
            }}
          >
            {remove.isPending ? "Moving…" : partial ? "Try again" : "Move to trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddToHeader({ api, albumId, kind }: { api: Api; albumId: string; kind: LibraryKind }) {
  const { data: albums } = useQuery(albumsQuery(api));
  const own = albums?.items.find((a) => a.albumId === albumId);
  // A collaborative album shared with me (FR-SHR-11): usually cached from its page.
  const { data: shared } = useInfiniteQuery({
    ...sharedAlbumsQuery(api),
    enabled: !!albums && !own,
  });
  const target =
    own ?? shared?.pages.flatMap((page) => page.items).find((a) => a.albumId === albumId);
  const name = target?.name;
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">
        {name ? `Add to ${name}` : "Add to album"}
      </h1>
      <p className="text-sm text-muted-foreground">
        Select the {NOUN[kind].many} to add.{" "}
        {/* Albums hold both (FR-VID-11): switch between the two lists while adding. */}
        <Link
          to={kind === "video" ? "/gallery" : "/videos"}
          search={{ addTo: albumId }}
          replace
          className="font-medium text-foreground underline underline-offset-4"
        >
          {kind === "video" ? "Add photos instead" : "Add videos instead"}
        </Link>
      </p>
      {/* Before adding, so members know where their photos will be shown (FR-SHR-12). */}
      {target?.showLocations && (
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          <MapPin aria-hidden className="size-3.5 shrink-0" />
          Locations are shown in this album: everyone in it will see where these photos were taken.
        </p>
      )}
    </header>
  );
}

/**
 * Picking photos for an album, opened from its "Add photos" (`?addTo=`): adds them and returns to
 * the album; Cancel just returns.
 */
function AddToBar({
  albumId,
  photoIds,
  kind,
}: {
  albumId: string;
  photoIds: string[];
  kind: LibraryKind;
}) {
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
            : `Add ${itemsText(kind, photoIds.length)}`}
      </Button>
    </SelectionBar>
  );
}

const SORT_LABELS: Record<PhotoSort, string> = {
  "taken-desc": "Newest first",
  "taken-asc": "Oldest first",
};

/** Shown in the closed picker on a phone, where the full labels don't fit on one row. */
const SHORT_SORT_LABELS: Record<PhotoSort, string> = {
  "taken-desc": "Newest",
  "taken-asc": "Oldest",
};

/** Sort order. Albums open from the Albums page (no album picker here); places from the search. */
function GalleryFilters({
  sort,
  setSearch,
}: {
  sort: PhotoSort;
  setSearch: (change: (prev: GallerySearch) => GallerySearch) => void;
}) {
  return (
    <div className="flex gap-2">
      <Select
        value={sort}
        onValueChange={(value) => setSearch((prev) => ({ ...prev, sort: value as PhotoSort }))}
      >
        <SelectTrigger aria-label="Sort order" className="shrink-0 md:w-36">
          <SelectValue>
            {/* Screen readers always get the full label. */}
            <span aria-hidden className="md:hidden">
              {SHORT_SORT_LABELS[sort]}
            </span>
            <span className="sr-only md:not-sr-only">{SORT_LABELS[sort]}</span>
          </SelectValue>
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
function PlaceFilter({ api, placeId }: { api: Api; placeId: string }) {
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

function EmptyGallery({ kind, inAlbum }: { kind: LibraryKind; inAlbum: boolean }) {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <p className="text-muted-foreground">
        {inAlbum ? "This album has no photos yet." : `No ${NOUN[kind].many} yet.`}
      </p>
      {!inAlbum && (
        <Button asChild>
          <Link to="/upload">Upload {NOUN[kind].many}</Link>
        </Button>
      )}
    </div>
  );
}

/** Room the sticky header takes at the top of the screen when scrolling to a month. */
const HEADER_ROOM = 64;

/**
 * The timeline scrubber's side of the page (8.36, FR-GAL-9): the months (`GET /photos/timeline`)
 * in the list's order, the month at the top of the screen, and what a scrub does. A month whose
 * heading is loaded is scrolled to (live while dragging); any other one, on release, restarts the
 * list there (`from`, the API's `start`) and newer photos load in above while scrolling up.
 */
function useTimeline({
  api,
  kind,
  search,
  setSearch,
  enabled,
}: {
  api: Api;
  kind: LibraryKind;
  search: GallerySearch;
  setSearch: (change: (prev: GallerySearch) => GallerySearch) => void;
  enabled: boolean;
}) {
  const { data } = useQuery({ ...timelineQuery(api, kind), enabled });
  const months = useMemo(() => {
    const newestFirst = enabled ? (data?.months ?? []) : [];
    return search.sort === "taken-desc" ? newestFirst : [...newestFirst].reverse();
  }, [data, enabled, search.sort]);

  const offsets = useRef<MonthOffset[]>([]);
  const pending = useRef<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  const scrollTo = (month: string) => {
    const heading = offsets.current.find((m) => m.month === month);
    if (!heading) return false;
    window.scrollTo(0, Math.max(0, heading.top - HEADER_ROOM));
    return true;
  };

  const update = useCallback(() => {
    const line = window.scrollY + HEADER_ROOM + 1;
    let month = offsets.current[0]?.month ?? null;
    for (const heading of offsets.current) {
      if (heading.top <= line) month = heading.month;
      else break;
    }
    setCurrent(month);
  }, []);

  const onMonthOffsets = useCallback(
    (next: MonthOffset[]) => {
      offsets.current = next;
      // After a jump: put the month asked for at the top once its photos are laid out.
      if (pending.current && scrollTo(pending.current)) pending.current = null;
      update();
    },
    [update],
  );

  useEffect(() => {
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [update]);

  const scrub = (month: string, final: boolean) => {
    if (scrollTo(month) || !final) return;
    pending.current = month;
    // The first month of the list is its start: no jump needed.
    const from = month === months[0]?.month ? undefined : jumpStart(month, search.sort);
    setSearch((prev) => ({ ...prev, from }));
  };

  return { months, current, onMonthOffsets, scrub };
}
