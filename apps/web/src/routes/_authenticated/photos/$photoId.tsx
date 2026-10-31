import { TRASH_RETENTION_DAYS, type Photo } from "@photo-app/shared";
import {
  InfiniteQueryObserver,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  FolderMinus,
  FolderPlus,
  ImageOff,
  ImagePlus,
  ImageUp,
  LoaderCircle,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useImageFailed } from "@/components/useImageFailed";
import { ShareLinkButton } from "@/links/ShareLinkDialog";
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
import { AddToAlbumDialog } from "@/albums/AddToAlbumDialog";
import { sharedBy } from "@/albums/sharedBy";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { gallerySearchSchema } from "@/gallery/search";
import { startDownload } from "@/lib/download";
import { albumsQuery, useRemoveFromAlbum, useUpdateAlbum } from "@/queries/albums";
import { galleryQuery, needsOwnFetch, photoQuery, removePhotoFromCache } from "@/queries/photos";
import { saveSummary, sharedAlbumsQuery, useSaveSharedPhotos } from "@/queries/shares";
import { ZoomableImage } from "@/viewer/ZoomableImage";

/** Horizontal travel that counts as a swipe; it must also be mostly sideways. */
const SWIPE_MIN_PX = 50;
/** Load the next gallery page when the viewer gets this close to the end of the loaded ones. */
const LOOKAHEAD_PHOTOS = 3;
/** How far an album or place list is paged to find the photo opened (from the map, 13.2h). */
const MAX_SEARCH_PAGES = 20;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

// Full-screen viewer (FR-GAL-4, §12.1). `album`/`place`/`sort` say which gallery list prev/next walk.
export const Route = createFileRoute("/_authenticated/photos/$photoId")({
  staticData: { fullScreen: true },
  validateSearch: gallerySearchSchema,
  loaderDeps: ({ search: { album, place, sort } }) => ({ album, place, sort }),
  loader: async ({ context: { queryClient, api }, params: { photoId }, deps }) => {
    // Usually cached from the gallery. A photo beyond the loaded pages (deep link) is fetched on
    // its own; then there is no prev/next. 404 for other users' photos (NFR-SEC-2).
    let { pages } = await queryClient.infiniteQuery({
      ...galleryQuery(api, deps),
      staleTime: "static",
    });
    const listed = () => pages.some((page) => page.items.some((p) => p.photoId === photoId));
    // An album or place list is paged on until the photo turns up, so prev/next work for a photo
    // opened from the map in its town's list (13.2h). Not for all photos: that list can be long.
    if (deps.album || deps.place) {
      const observer = new InfiniteQueryObserver(queryClient, galleryQuery(api, deps));
      let more = pages.at(-1)?.nextCursor != null;
      for (let n = 0; !listed() && more && n < MAX_SEARCH_PAGES; n++) {
        const result = await observer.fetchNextPage();
        if (!result.data) break;
        pages = result.data.pages;
        more = result.hasNextPage;
      }
    }
    if (!listed()) {
      await queryClient.query({ ...photoQuery(api, photoId, deps.album), staleTime: "static" });
    }
  },
  component: Viewer,
  errorComponent: ViewerError,
});

function Viewer() {
  const { api } = Route.useRouteContext();
  const { photoId } = Route.useParams();
  const { album, place, sort } = Route.useSearch();
  const navigate = Route.useNavigate();
  const close = useClose();

  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = useSuspenseInfiniteQuery(
    galleryQuery(api, { album, place, sort }),
  );
  const photos = useMemo(() => data.pages.flatMap((page) => page.items), [data]);
  const index = photos.findIndex((p) => p.photoId === photoId);
  const listed = index >= 0 ? photos[index] : undefined;
  // Outside the loaded pages, or a shared album's photo (listed without its preview, 7.4).
  const single = useQuery({
    ...photoQuery(api, photoId, album),
    enabled: index < 0 || needsOwnFetch(listed),
  });
  const photo = index < 0 || needsOwnFetch(listed) ? (single.data ?? listed) : listed;
  const loadingPreview = needsOwnFetch(listed) && single.isPending;
  const prev = index > 0 ? photos[index - 1] : undefined;
  const next = index >= 0 ? photos[index + 1] : undefined;

  useEffect(() => {
    if (index >= 0 && index >= photos.length - LOOKAHEAD_PHOTOS && hasNextPage) {
      if (!isFetchingNextPage) void fetchNextPage();
    }
  }, [index, photos.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Replace, so Back/close returns to the gallery rather than through every photo seen.
  const show = useCallback(
    async (target: Photo | undefined) => {
      if (!target) return;
      await navigate({
        params: { photoId: target.photoId },
        search: (s) => s,
        replace: true,
      });
    },
    [navigate],
  );

  // The delete dialog handles its own keys (Escape closes only the dialog); so do the album
  // menu and dialog (`overlay`).
  const [confirming, setConfirming] = useState(false);
  const [overlay, setOverlay] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (confirming || overlay || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowLeft") void show(prev);
      else if (event.key === "ArrowRight") void show(next);
      else if (event.key === "Escape") close();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, overlay, show, close, prev, next]);

  const prevPhoto = useQuery({
    ...photoQuery(api, prev?.photoId ?? "", album),
    enabled: needsOwnFetch(prev),
  }).data;
  const nextPhoto = useQuery({
    ...photoQuery(api, next?.photoId ?? "", album),
    enabled: needsOwnFetch(next),
  }).data;
  // Shared neighbours: their photo is fetched now, so prev/next show at once.
  usePreload((prevPhoto ?? prev)?.previewUrl, (nextPhoto ?? next)?.previewUrl);
  const swipe = useSwipe({ onLeft: () => void show(next), onRight: () => void show(prev) });

  // After a delete: the neighbour takes its place, or the gallery if it was the only photo.
  const afterDelete = useCallback(async () => {
    if (next ?? prev) await show(next ?? prev);
    else close();
  }, [next, prev, show, close]);

  // The loader fetched it; missing only if it went away since (e.g. deleted on another device).
  if (!photo) return single.isError ? <ErrorScreen error={single.error} /> : null;

  return (
    <main className="fixed inset-0 flex flex-col bg-black text-white">
      <header className="relative z-10 flex items-center gap-3 p-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Close"
          onClick={close}
          className="text-white hover:bg-white/10 hover:text-white"
        >
          <X className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          {/* Not shown (user request 2026-10-28), only announced: the photo needs a name. */}
          <h1 className="sr-only">{photo.fileName}</h1>
          {photo.status === "ready" && (
            <p className="text-sm text-white/80">{dateFormat.format(new Date(photo.takenAt))}</p>
          )}
          {photo.place && (
            // Own photos only: the API leaves the place out for share recipients (13.2g).
            <p className="truncate text-xs text-white/60">
              {[photo.place.city, photo.place.country].join(", ")}
            </p>
          )}
          {album && <SharedByLine album={album} photo={photo} />}
        </div>
        <PhotoActions
          key={photo.photoId}
          photo={photo}
          album={album}
          confirming={confirming}
          setConfirming={setConfirming}
          setOverlay={setOverlay}
          onDeleted={afterDelete}
        />
      </header>

      <div
        className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center select-none"
        {...swipe}
      >
        <PhotoView
          key={photo.photoId}
          photo={photo}
          album={album}
          loadingPreview={loadingPreview}
          keys={!confirming && !overlay}
        />
        <NavButton label="Previous photo" target={prev} side="left" />
        <NavButton label="Next photo" target={next} side="right" />
      </div>
    </main>
  );
}

const iconButton = "text-white hover:bg-white/10 hover:text-white";

/**
 * Whose photo this is when it isn't mine: "Added by @name" in a collaborative album (FR-SHR-11),
 * else "Shared by @name" for a photo seen through an album shared with me (FR-SHR-3).
 */
function SharedByLine({ album, photo }: { album: string; photo: Photo }) {
  const { api, user } = Route.useRouteContext();
  const { data: albums } = useQuery(albumsQuery(api));
  const own = !albums || albums.items.some((a) => a.albumId === album);
  // Usually cached from the albums page; only the loaded pages are searched.
  const { data } = useInfiniteQuery({ ...sharedAlbumsQuery(api), enabled: !own });
  const shared = own
    ? undefined
    : data?.pages.flatMap((page) => page.items).find((a) => a.albumId === album);
  const line = (text: string) => <p className="truncate text-xs text-white/60">{text}</p>;
  if (photo.ownerId === user.sub) return null;
  // Another member's photo, or in my own album: the album's owner didn't add it.
  if (photo.ownerId !== null && (own || photo.ownerId !== shared?.ownerId)) {
    return line(photo.ownerUsername ? `Added by @${photo.ownerUsername}` : "Added by a member");
  }
  return shared ? line(sharedBy(shared)) : null;
}

/**
 * Download (FR-DL-1/2), a public link (FR-SHR-8) and delete to the trash (FR-DEL-1/2/3). Delete is
 * offered for own photos only; someone else's photo (in an album shared with me, or a member's in
 * my collaborative album, FR-SHR-11) can be saved to my gallery instead (FR-SHR-10). In my own
 * album I can also take others' photos out and make them the cover.
 */
function PhotoActions({
  photo,
  album,
  confirming,
  setConfirming,
  setOverlay,
  onDeleted,
}: {
  photo: Photo;
  album: string | undefined;
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  setOverlay: (open: boolean) => void;
  onDeleted: () => Promise<void>;
}) {
  const { api, user } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { data: albums } = useQuery({ ...albumsQuery(api), enabled: album !== undefined });
  const albumIsMine = album !== undefined && !!albums?.items.some((a) => a.albumId === album);
  // `ownerId` says whose photo it is (FR-SHR-11). Without it (cached from an older API) a photo
  // in an album that isn't in my list belongs to that album's owner.
  const mine =
    photo.ownerId !== null ? photo.ownerId === user.sub : album === undefined || albumIsMine;
  // A photo in the trash (opened by its URL) can only be restored there (FR-DEL-3).
  const own = !photo.trashedAt && mine;
  // Known only once my albums are loaded, so an own album never shows the button meanwhile.
  const shared = album !== undefined && !!albums && !mine;

  // A 5-minute pre-signed URL with `attachment` disposition: the browser saves the original
  // under its file name straight from S3. A shared photo needs its album (5.13).
  const download = useMutation({
    mutationFn: () => api.photos.downloadUrl(photo.photoId, album),
    onSuccess: ({ url }) => startDownload(url),
  });

  const remove = useMutation({
    mutationFn: () => api.photos.delete(photo.photoId),
    onSuccess: async () => {
      setConfirming(false);
      await onDeleted();
      // Only once the viewer has moved on, so it never looks the deleted photo up again.
      removePhotoFromCache(queryClient, photo.photoId);
      for (const key of [["photos"], ["albums"], ["places"], ["trash"], ["me"]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  return (
    <>
      {download.isError && (
        <p
          role="alert"
          className="absolute top-full right-2 max-w-[calc(100%-1rem)] rounded-md bg-black/80 px-3 py-2 text-sm text-red-300"
        >
          {errorMessage(download.error)}
        </p>
      )}
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label="Download original"
        title={photo.status === "pending" ? "Available once the upload is finished" : undefined}
        disabled={photo.status === "pending" || download.isPending}
        onClick={() => download.mutate()}
        className={iconButton}
      >
        {download.isPending ? (
          <LoaderCircle className="size-5 motion-safe:animate-spin" />
        ) : (
          <Download className="size-5" />
        )}
      </Button>
      {shared && photo.status === "ready" && (
        <SaveToGalleryButton photoId={photo.photoId} albumId={album} asOwner={albumIsMine} />
      )}
      {own && photo.status === "ready" && (
        <ShareLinkButton photoId={photo.photoId} setOverlay={setOverlay} className={iconButton} />
      )}
      {(own || (albumIsMine && !photo.trashedAt)) && (
        <AlbumActions
          photo={photo}
          album={album}
          mine={own}
          albumIsMine={albumIsMine}
          setOverlay={setOverlay}
          onRemoved={onDeleted}
        />
      )}
      {own && (
        <AlertDialog
          open={confirming}
          onOpenChange={(open) => {
            if (remove.isPending) return;
            setConfirming(open);
            if (!open) remove.reset();
          }}
        >
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Delete photo"
            onClick={() => setConfirming(true)}
            className={iconButton}
          >
            <Trash2 className="size-5" />
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Move this photo to the trash?</AlertDialogTitle>
              <AlertDialogDescription>
                {photo.fileName} will be removed from your library and from all albums, and deleted
                for good after {TRASH_RETENTION_DAYS} days. Until then you can restore it from the
                trash.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {remove.isError && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(remove.error)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={remove.isPending}
                onClick={(event) => {
                  event.preventDefault(); // stay open until the API answers
                  remove.mutate();
                }}
              >
                {remove.isPending ? "Moving…" : "Move to trash"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

/**
 * "Save to my gallery" for a photo of an album shared with me (FR-SHR-10): a copy becomes my own
 * photo. The result (saved, already saved, storage full) shows under the toolbar.
 */
function SaveToGalleryButton({
  photoId,
  albumId,
  asOwner,
}: {
  photoId: string;
  albumId: string;
  /** A member's photo in my own collaborative album (FR-SHR-11). */
  asOwner: boolean;
}) {
  const save = useSaveSharedPhotos(albumId, { asOwner });
  // A result belongs to the photo it was for: prev/next reuse this component.
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const message = savedFor === photoId && save.data ? saveSummary(save.data) : null;
  return (
    <>
      {save.isError && savedFor === photoId && (
        <p
          role="alert"
          className="absolute top-full right-2 max-w-[calc(100%-1rem)] rounded-md bg-black/80 px-3 py-2 text-sm text-red-300"
        >
          {errorMessage(save.error)}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="absolute top-full right-2 max-w-[calc(100%-1rem)] rounded-md bg-black/80 px-3 py-2 text-sm text-white"
        >
          {message}
        </p>
      )}
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label="Save to my gallery"
        title="Save to my gallery"
        disabled={save.isPending}
        onClick={() => {
          setSavedFor(photoId);
          save.mutate([photoId]);
        }}
        className={iconButton}
      >
        {save.isPending ? (
          <LoaderCircle className="size-5 motion-safe:animate-spin" />
        ) : (
          <ImagePlus className="size-5" />
        )}
      </Button>
    </>
  );
}

/**
 * Album actions (FR-ALB-2): add an own photo to an album; inside my album, make any photo the
 * cover; take a photo out (the photo stays in its owner's library, the viewer moves on as after a
 * delete): any photo of my album, or my own one from a collaborative album (FR-SHR-11).
 */
function AlbumActions({
  photo,
  album,
  mine,
  albumIsMine,
  setOverlay,
  onRemoved,
}: {
  photo: Photo;
  album: string | undefined;
  mine: boolean;
  albumIsMine: boolean;
  setOverlay: (open: boolean) => void;
  onRemoved: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const cover = useUpdateAlbum(album ?? "");
  const remove = useRemoveFromAlbum(album ?? "", { beforeCacheUpdate: onRemoved });
  const error = cover.error ?? remove.error;

  useEffect(() => setOverlay(menuOpen || adding), [menuOpen, adding, setOverlay]);

  return (
    <>
      {(status || error) && (
        <p
          role={error ? "alert" : "status"}
          className={`absolute top-full right-2 max-w-[calc(100%-1rem)] rounded-md bg-black/80 px-3 py-2 text-sm ${error ? "text-red-300" : "text-white"}`}
        >
          {error ? errorMessage(error) : status}
        </p>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-lg" aria-label="Album actions" className={iconButton}>
            <Ellipsis className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {mine && (
            <DropdownMenuItem onSelect={() => setAdding(true)}>
              <FolderPlus aria-hidden />
              Add to album…
            </DropdownMenuItem>
          )}
          {album && (
            <>
              {albumIsMine && (
                <DropdownMenuItem
                  disabled={photo.status !== "ready" || cover.isPending}
                  onSelect={() =>
                    cover.mutate(
                      { coverPhotoId: photo.photoId },
                      { onSuccess: () => setStatus("Set as album cover") },
                    )
                  }
                >
                  <ImageUp aria-hidden />
                  Set as album cover
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={remove.isPending}
                onSelect={() => remove.mutate([photo.photoId])}
              >
                <FolderMinus aria-hidden />
                Remove from album
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AddToAlbumDialog
        photoIds={[photo.photoId]}
        open={adding}
        onOpenChange={setAdding}
        onAdded={(target) => setStatus(`Added to ${target.name}`)}
      />
    </>
  );
}

/**
 * Preview, or a state for photos without one (FR-GAL-5) or whose preview can't load. While a
 * shared photo's preview URL is on its way (7.4), its thumbnail stands in.
 */
function PhotoView({
  photo,
  album,
  loadingPreview,
  keys,
}: {
  photo: Photo;
  album: string | undefined;
  loadingPreview: boolean;
  keys: boolean;
}) {
  const { api } = Route.useRouteContext();
  const [broken, onError] = useImageFailed(photo.previewUrl);
  if (photo.status === "pending") {
    return (
      <Message icon={<LoaderCircle className="size-8 motion-safe:animate-spin" />}>
        This photo is still processing.
      </Message>
    );
  }
  if (photo.status === "failed") {
    return (
      <Message icon={<ImageOff className="size-8 text-red-400" />}>
        This photo couldn't be processed. The original file is kept.
      </Message>
    );
  }
  if (loadingPreview && photo.thumbUrl) {
    return (
      <img
        src={photo.thumbUrl}
        alt={photo.fileName}
        draggable={false}
        className="size-full object-contain"
      />
    );
  }
  if (!photo.previewUrl || broken) {
    return <Message icon={<ImageOff className="size-8" />}>The preview can't be shown.</Message>;
  }
  return (
    <ZoomableImage
      api={api}
      photo={photo}
      album={album}
      src={photo.previewUrl}
      keys={keys}
      onError={onError}
    />
  );
}

function Message({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 px-6 text-center text-white/70">
      {icon}
      <p className="text-sm">{children}</p>
    </div>
  );
}

function NavButton({
  label,
  target,
  side,
}: {
  label: string;
  target: Photo | undefined;
  side: "left" | "right";
}) {
  if (!target) return null;
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <Link
      from={Route.fullPath}
      to="."
      params={{ photoId: target.photoId }}
      search={(s) => s}
      replace
      aria-label={label}
      className={`absolute top-1/2 ${side === "left" ? "left-2" : "right-2"} grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white outline-offset-2 hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-white`}
    >
      <Icon className="size-6" />
    </Link>
  );
}

/** Back to where the viewer was opened from (keeps the gallery's scroll), else to the gallery. */
function useClose() {
  const router = useRouter();
  const search = Route.useSearch();
  return useCallback(() => {
    if (router.history.canGoBack()) router.history.back();
    else void router.navigate({ to: "/gallery", search });
  }, [router, search]);
}

/** Warms the browser cache with the neighbours' previews so prev/next show instantly. */
function usePreload(...urls: (string | null | undefined)[]) {
  const key = urls.join("\n");
  useEffect(() => {
    for (const url of key.split("\n")) {
      if (url) new Image().src = url;
    }
  }, [key]);
}

/** Horizontal swipe on touch (and mouse drag): left → next, right → previous. */
function useSwipe({ onLeft, onRight }: { onLeft: () => void; onRight: () => void }) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  return {
    onPointerDown: (event: PointerEvent) => {
      if (event.isPrimary)
        start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerUp: (event: PointerEvent) => {
      const from = start.current;
      start.current = null;
      if (!from || from.id !== event.pointerId) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) onLeft();
      else onRight();
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

// e.g. a deleted photo or another user's (404), or no network.
function ViewerError({ error }: ErrorComponentProps) {
  return <ErrorScreen error={error} />;
}

function ErrorScreen({ error }: { error: unknown }) {
  const close = useClose();
  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-black px-6 text-center text-white">
      <p className="text-white/80">{errorMessage(error)}</p>
      <Button variant="secondary" onClick={close}>
        Back to the gallery
      </Button>
    </main>
  );
}
