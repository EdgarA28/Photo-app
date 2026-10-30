import type { LinkedPhoto } from "@photo-app/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Download, ImageOff, LoaderCircle, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ApiRequestError, errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useImageFailed } from "@/components/useImageFailed";
import { startDownload } from "@/lib/download";

// A public photo link (FR-SHR-8): anyone with it sees the photos and can download the originals
// until the link expires (15 min), without an account. One photo shows full screen; several show
// as a grid, a tap opens one large. Outside the authenticated layout: no login, no app shell.
export const Route = createFileRoute("/s/$token")({
  component: LinkPage,
});

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Unknown, expired or emptied links all answer 404 (no way to tell them apart). */
const isGone = (error: unknown) => error instanceof ApiRequestError && error.status === 404;
const goneText = "This link has expired or doesn't exist anymore.";

function LinkPage() {
  const { api } = Route.useRouteContext();
  const { token } = Route.useParams();
  const link = useQuery({
    queryKey: ["links", token],
    queryFn: ({ signal }) => api.links.get(token, { signal }),
    // Its URLs are signed until the link expires: nothing to refresh, no retries on a 404.
    staleTime: Infinity,
    retry: (count, error) => !isGone(error) && count < 2,
  });
  const [open, setOpen] = useState<number | null>(null);

  if (link.isPending) {
    return (
      <Shell>
        <LoaderCircle
          aria-label="Loading"
          className="m-auto size-8 text-white/60 motion-safe:animate-spin"
        />
      </Shell>
    );
  }
  if (link.isError) {
    return (
      <Shell>
        <Message>{isGone(link.error) ? goneText : errorMessage(link.error)}</Message>
      </Shell>
    );
  }

  const { photos, expiresAt } = link.data;
  const until = `Link works until ${timeFormat.format(new Date(expiresAt))}`;
  if (photos.length === 1 || open !== null) {
    const index = photos.length === 1 ? 0 : open!;
    return (
      <LargePhoto
        token={token}
        photos={photos}
        index={index}
        until={until}
        onIndex={setOpen}
        onClose={photos.length === 1 ? undefined : () => setOpen(null)}
      />
    );
  }

  return (
    <Shell>
      <header className="flex flex-wrap items-baseline gap-x-3 p-4 pb-2">
        <h1 className="text-lg font-semibold">{photos.length} shared photos</h1>
        <p className="text-sm text-white/70">{until}</p>
      </header>
      <ul className="grid grid-cols-3 gap-1 overflow-y-auto p-1 sm:grid-cols-4 lg:grid-cols-6">
        {photos.map((photo, i) => (
          <li key={photo.photoId}>
            <Thumb photo={photo} label={`Photo ${i + 1}`} onOpen={() => setOpen(i)} />
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="fixed inset-0 flex flex-col bg-black text-white">{children}</main>;
}

function Thumb({
  photo,
  label,
  onOpen,
}: {
  photo: LinkedPhoto;
  label: string;
  onOpen: () => void;
}) {
  const [broken, onError] = useImageFailed(photo.thumbUrl);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onOpen}
      className="relative block aspect-square w-full overflow-hidden rounded-sm bg-white/10 outline-none focus-visible:ring-3 focus-visible:ring-white/50"
    >
      {broken ? (
        <ImageOff aria-hidden className="absolute inset-0 m-auto size-6 text-white/50" />
      ) : (
        <img
          src={photo.thumbUrl}
          alt=""
          loading="lazy"
          onError={onError}
          className="size-full object-cover"
        />
      )}
    </button>
  );
}

/** One photo large, with its download; prev/next and close when the link has several. */
function LargePhoto({
  token,
  photos,
  index,
  until,
  onIndex,
  onClose,
}: {
  token: string;
  photos: LinkedPhoto[];
  index: number;
  until: string;
  onIndex: (index: number) => void;
  onClose: (() => void) | undefined;
}) {
  const { api } = Route.useRouteContext();
  const photo = photos[index]!;
  const download = useMutation({
    mutationFn: (photoId: string) => api.links.downloadUrl(token, photoId),
    onSuccess: ({ url }) => startDownload(url),
  });
  const [broken, onError] = useImageFailed(photo.previewUrl);
  const prev = index > 0 ? () => onIndex(index - 1) : undefined;
  const next = index < photos.length - 1 ? () => onIndex(index + 1) : undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (event.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
      else if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length, onIndex, onClose]);

  const nav = "absolute top-1/2 -translate-y-1/2 text-white hover:bg-white/10 hover:text-white";
  return (
    <Shell>
      {onClose && (
        <header className="flex items-center gap-2 p-2">
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Back to all photos"
            onClick={onClose}
            className="text-white hover:bg-white/10 hover:text-white"
          >
            <X className="size-5" />
          </Button>
          <p className="text-sm text-white/70 tabular-nums">
            {index + 1} / {photos.length}
          </p>
        </header>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {broken ? (
          <Message icon>{goneText}</Message>
        ) : (
          <img
            key={photo.photoId}
            src={photo.previewUrl}
            alt={photos.length === 1 ? "Shared photo" : `Photo ${index + 1}`}
            width={photo.width ?? undefined}
            height={photo.height ?? undefined}
            onError={onError}
            className="max-h-full max-w-full object-contain"
          />
        )}
        {prev && (
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Previous photo"
            onClick={prev}
            className={`${nav} left-2`}
          >
            <ChevronLeft className="size-6" />
          </Button>
        )}
        {next && (
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Next photo"
            onClick={next}
            className={`${nav} right-2`}
          >
            <ChevronRight className="size-6" />
          </Button>
        )}
      </div>
      {!broken && (
        <footer className="flex flex-wrap items-center gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <p className="mr-auto text-sm text-white/70">{until}</p>
          {download.isError && (
            <p role="alert" className="w-full text-sm text-red-300 sm:w-auto">
              {isGone(download.error) ? goneText : errorMessage(download.error)}
            </p>
          )}
          <Button
            variant="secondary"
            disabled={download.isPending}
            onClick={() => download.mutate(photo.photoId)}
          >
            {download.isPending ? (
              <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
            ) : (
              <Download aria-hidden />
            )}
            Download original
          </Button>
        </footer>
      )}
    </Shell>
  );
}

function Message({ children, icon = false }: { children: string; icon?: boolean }) {
  return (
    <div role="status" className="m-auto flex max-w-xs flex-col items-center gap-3 p-4 text-center">
      {icon && <ImageOff aria-hidden className="size-8 text-white/60" />}
      <p className="text-white/80">{children}</p>
    </div>
  );
}
