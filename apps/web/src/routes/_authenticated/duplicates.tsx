import { TRASH_RETENTION_DAYS, type DuplicateGroup, type Photo } from "@photo-app/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { CopyCheck, ImageOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiRequestError, errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useImageFailed } from "@/components/useImageFailed";
import { formatBytes } from "@/lib/format";
import { duplicatesQuery, useDismissDuplicates } from "@/queries/duplicates";
import { useDeletePhotos } from "@/queries/photos";

// Duplicates (8.37g, FR-GAL-12, §12.1), opened from Settings: groups of own photos that are copies
// of each other (the same file uploaded again, an upload and its Google Photos import). Per group
// keep one and move the others to the trash, or say they aren't duplicates.
export const Route = createFileRoute("/_authenticated/duplicates")({
  loader: ({ context }) =>
    context.queryClient.query({ ...duplicatesQuery(context.api), staleTime: "static" }),
  component: Duplicates,
  errorComponent: DuplicatesError,
});

const photosText = (count: number) => (count === 1 ? "1 photo" : `${count} photos`);

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Duplicates() {
  const { api } = Route.useRouteContext();
  const { data } = useSuspenseQuery(duplicatesQuery(api));
  const [message, setMessage] = useState<ReactNode>(null);
  const copies = data.groups.reduce((n, group) => n + group.photos.length - 1, 0);

  return (
    <main className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Duplicates</h1>
      <p className="text-sm text-muted-foreground">
        Copies of the same photo, like a file uploaded twice or a photo both uploaded and imported
        from Google Photos. Keep one: the others move to the trash, where you can restore them for{" "}
        {TRASH_RETENTION_DAYS} days.
      </p>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      {data.groups.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <CopyCheck aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">No duplicates found.</p>
        </div>
      ) : (
        <>
          <p className="text-sm font-medium">
            {data.groups.length === 1 ? "1 group" : `${data.groups.length} groups`},{" "}
            {copies === 1 ? "1 extra copy" : `${copies} extra copies`}
          </p>
          <ul className="space-y-4">
            {data.groups.map((group) => (
              <li key={group.key}>
                <Group group={group} onDone={setMessage} />
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

/** One group: its photos side by side, "Keep" on each, "Not duplicates" for the group. */
function Group({ group, onDone }: { group: DuplicateGroup; onDone: (message: ReactNode) => void }) {
  const remove = useDeletePhotos();
  const dismiss = useDismissDuplicates();
  const busy = remove.isPending || dismiss.isPending;
  const failed = remove.data && remove.data.failed.length > 0 ? remove.data : undefined;
  const [keeping, setKeeping] = useState<string | null>(null);
  const changed =
    dismiss.error instanceof ApiRequestError && dismiss.error.status === 409
      ? "These photos changed meanwhile: the list is up to date now, have another look."
      : null;
  const label = `${group.photos.length} copies`;

  const keep = (photo: Photo) => {
    setKeeping(photo.photoId);
    const others = group.photos.filter((p) => p.photoId !== photo.photoId).map((p) => p.photoId);
    remove.mutate(others, {
      onSuccess: ({ deleted, failed: left }) => {
        if (left.length > 0) return;
        onDone(
          <>
            Kept {photo.fileName} and moved {photosText(deleted.length)} to the{" "}
            <Link to="/trash" className="font-medium text-foreground underline underline-offset-4">
              trash
            </Link>
            .
          </>,
        );
      },
    });
  };

  return (
    <section aria-label={label} className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{label}</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            dismiss.mutate(
              { key: group.key, photoIds: group.photos.map((p) => p.photoId) },
              { onSuccess: () => onDone("Marked as not duplicates.") },
            )
          }
        >
          {dismiss.isPending ? "Saving…" : "Not duplicates"}
        </Button>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {group.photos.map((photo) => (
          <li key={photo.photoId} className="space-y-1.5">
            <Copy photo={photo} />
            <Button
              size="sm"
              className="w-full"
              disabled={busy}
              aria-label={`Keep ${photo.fileName}`}
              onClick={() => keep(photo)}
            >
              {remove.isPending && keeping === photo.photoId ? "Moving others…" : "Keep"}
            </Button>
          </li>
        ))}
      </ul>
      {(failed || remove.isError || (dismiss.isError && !changed) || changed) && (
        <p role="alert" className="text-sm text-destructive">
          {changed ??
            (failed
              ? `${photosText(failed.failed.length)} couldn't be moved to the trash: ${errorMessage(failed.error)}`
              : errorMessage(remove.error ?? dismiss.error))}
        </p>
      )}
    </section>
  );
}

/** A copy: its thumbnail (opens it in the viewer, to compare them large) and details. */
function Copy({ photo }: { photo: Photo }) {
  const [broken, onError] = useImageFailed(photo.thumbUrl);
  const size = photo.width && photo.height ? `${photo.width} × ${photo.height}` : null;
  return (
    <>
      <Link
        to="/photos/$photoId"
        params={{ photoId: photo.photoId }}
        aria-label={`View ${photo.fileName}`}
        className="relative block aspect-square overflow-hidden rounded-sm bg-muted outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {photo.thumbUrl && !broken ? (
          <img
            src={photo.thumbUrl}
            alt=""
            loading="lazy"
            onError={onError}
            className="size-full object-cover"
          />
        ) : (
          <ImageOff aria-hidden className="absolute inset-0 m-auto size-6 text-muted-foreground" />
        )}
      </Link>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p className="truncate font-medium text-foreground" title={photo.fileName}>
          {photo.fileName}
        </p>
        <p>{dateFormat.format(new Date(photo.takenAt))}</p>
        <p>{[formatBytes(photo.sizeBytes), size].filter(Boolean).join(" · ")}</p>
      </div>
    </>
  );
}

// e.g. no network.
function DuplicatesError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Duplicates</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </main>
  );
}
