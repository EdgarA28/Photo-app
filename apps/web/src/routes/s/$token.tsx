import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, ImageOff, LoaderCircle } from "lucide-react";
import { ApiRequestError, errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useImageFailed } from "@/components/useImageFailed";
import { startDownload } from "@/lib/download";

// A public photo link (FR-SHR-8): anyone with it sees the photo and can download the original
// until the link expires (15 min), without an account. Outside the authenticated layout: no
// login, no app shell.
export const Route = createFileRoute("/s/$token")({
  component: LinkedPhotoPage,
});

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Unknown, expired or removed links all answer 404 (no way to tell them apart). */
const isGone = (error: unknown) => error instanceof ApiRequestError && error.status === 404;
const goneText = "This link has expired or doesn't exist anymore.";

function LinkedPhotoPage() {
  const { api } = Route.useRouteContext();
  const { token } = Route.useParams();
  const photo = useQuery({
    queryKey: ["links", token],
    queryFn: ({ signal }) => api.links.get(token, { signal }),
    // Its URL is signed until the link expires: nothing to refresh, no retries on a 404.
    staleTime: Infinity,
    retry: (count, error) => !isGone(error) && count < 2,
  });
  const download = useMutation({
    mutationFn: () => api.links.downloadUrl(token),
    onSuccess: ({ url }) => startDownload(url),
  });
  const [broken, onError] = useImageFailed(photo.data?.previewUrl ?? null);

  return (
    <main className="fixed inset-0 flex flex-col bg-black text-white">
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {photo.isPending ? (
          <LoaderCircle
            aria-label="Loading"
            className="size-8 text-white/60 motion-safe:animate-spin"
          />
        ) : photo.isError ? (
          <Message>{isGone(photo.error) ? goneText : errorMessage(photo.error)}</Message>
        ) : broken ? (
          <Message icon>{goneText}</Message>
        ) : (
          <img
            src={photo.data.previewUrl}
            alt="Shared photo"
            width={photo.data.width ?? undefined}
            height={photo.data.height ?? undefined}
            onError={onError}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
      {photo.data && !broken && (
        <footer className="flex flex-wrap items-center gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <p className="mr-auto text-sm text-white/70">
            Link works until {timeFormat.format(new Date(photo.data.expiresAt))}
          </p>
          {download.isError && (
            <p role="alert" className="w-full text-sm text-red-300 sm:w-auto">
              {isGone(download.error) ? goneText : errorMessage(download.error)}
            </p>
          )}
          <Button
            variant="secondary"
            disabled={download.isPending}
            onClick={() => download.mutate()}
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
    </main>
  );
}

function Message({ children, icon = false }: { children: string; icon?: boolean }) {
  return (
    <div role="status" className="flex max-w-xs flex-col items-center gap-3 p-4 text-center">
      {icon && <ImageOff aria-hidden className="size-8 text-white/60" />}
      <p className="text-white/80">{children}</p>
    </div>
  );
}
