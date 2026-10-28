import { TRASH_RETENTION_DAYS, type Photo } from "@photo-app/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Check, ImageOff, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { useImageFailed } from "@/components/useImageFailed";
import { SelectionBar } from "@/gallery/SelectionBar";
import { useSelection } from "@/gallery/useSelection";
import { cn } from "@/lib/utils";
import {
  daysLeft,
  trashQuery,
  useDeleteForever,
  useEmptyTrash,
  useRestorePhotos,
  type TrashActionResult,
} from "@/queries/trash";

// The trash (FR-DEL-3): deleted photos stay here for 15 days, then the daily purge removes them.
// Tap photos to pick them, then restore them or delete them for good; or empty the whole trash.
export const Route = createFileRoute("/_authenticated/trash")({
  loader: ({ context }) =>
    context.queryClient.query({ ...trashQuery(context.api), staleTime: "static" }),
  component: Trash,
  errorComponent: TrashError,
});

const photosText = (count: number) => (count === 1 ? "1 photo" : `${count} photos`);

function Trash() {
  const { api } = Route.useRouteContext();
  const { data } = useSuspenseQuery(trashQuery(api));
  // Always picking: tiles only toggle, there is nothing else to do with them here.
  const selection = useSelection({ forced: true });
  const [message, setMessage] = useState<string | null>(null);
  const photos = data.items;
  // Photos that left the trash (restored, deleted elsewhere) can't stay picked.
  const picked = selection.ids.filter((id) => photos.some((p) => p.photoId === id));

  const finish = (text: string) => {
    selection.stop();
    setMessage(text);
  };

  return (
    <main className="space-y-4 pb-24 md:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">Trash</h1>
        {photos.length > 0 && <EmptyTrash count={photos.length} onDone={finish} />}
      </div>
      <p className="text-sm text-muted-foreground">
        Deleted photos stay here for {TRASH_RETENTION_DAYS} days, then they are deleted for good.
        They still count toward your storage until then.
      </p>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}

      {photos.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Trash2 aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">The trash is empty.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 lg:grid-cols-6">
          {photos.map((photo) => (
            <li key={photo.photoId}>
              <TrashTile
                photo={photo}
                selected={selection.selected.has(photo.photoId)}
                onToggle={() => {
                  setMessage(null);
                  selection.grid?.onToggle(photo.photoId);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {picked.length > 0 && (
        <SelectionBar count={picked.length} onCancel={selection.stop}>
          <RestoreSelected
            photoIds={picked}
            onDone={finish}
            onPartial={(done, text) => {
              selection.drop(done);
              setMessage(text ?? null);
            }}
          />
          <DeleteSelected photoIds={picked} onDone={finish} onPartial={selection.drop} />
        </SelectionBar>
      )}
    </main>
  );
}

function TrashTile({
  photo,
  selected,
  onToggle,
}: {
  photo: Photo;
  selected: boolean;
  onToggle: () => void;
}) {
  const [failed, onError] = useImageFailed(photo.thumbUrl);
  const days = daysLeft(photo);
  const left = days === 1 ? "1 day left" : `${days} days left`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${photo.fileName}, ${left}`}
      onClick={onToggle}
      className="relative block aspect-square w-full overflow-hidden rounded-sm bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {photo.thumbUrl && !failed ? (
        <img
          src={photo.thumbUrl}
          alt=""
          loading="lazy"
          onError={onError}
          className={cn(
            "size-full object-cover transition-transform motion-reduce:transition-none",
            selected && "scale-90 rounded-sm",
          )}
        />
      ) : (
        <ImageOff aria-hidden className="absolute inset-0 m-auto size-6 text-muted-foreground" />
      )}
      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[0.6875rem] font-medium text-white tabular-nums">
        {left}
      </span>
      <span
        aria-hidden
        className={cn(
          "absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-full border-2 border-white shadow",
          selected ? "bg-primary text-primary-foreground" : "bg-black/20",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

interface SelectedProps {
  photoIds: string[];
  onDone: (message: string) => void;
  /** Some photos failed: the others are unpicked, the failed ones stay for another try. */
  onPartial: (done: string[], message?: string) => void;
}

const failedText = (result: TrashActionResult, verb: string) =>
  `${photosText(result.failed.length)} couldn't be ${verb}: ${errorMessage(result.error)}`;

/** Restore needs no confirmation: nothing is lost. */
function RestoreSelected({ photoIds, onDone, onPartial }: SelectedProps) {
  const restore = useRestorePhotos();
  return (
    <Button
      variant="outline"
      disabled={restore.isPending}
      onClick={() =>
        restore.mutate(photoIds, {
          onSuccess: (result) => {
            if (result.failed.length > 0) {
              return onPartial(result.done, failedText(result, "restored"));
            }
            onDone(`Restored ${photosText(result.done.length)}.`);
          },
        })
      }
    >
      {restore.isPending ? "Restoring…" : "Restore"}
    </Button>
  );
}

/** Delete forever, after a confirmation (FR-DEL-2). */
function DeleteSelected({ photoIds, onDone, onPartial }: SelectedProps) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteForever();
  const partial = remove.data && remove.data.failed.length > 0 ? remove.data : undefined;
  const count = photosText(photoIds.length);

  return (
    <AlertDialog
      open={confirming}
      onOpenChange={(open) => {
        if (remove.isPending) return;
        setConfirming(open);
        if (!open) remove.reset();
      }}
    >
      <Button variant="destructive" onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {photoIds.length === 1 ? "Delete this photo forever?" : `Delete ${count} forever?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {photoIds.length === 1 ? "It" : "They"} will be deleted for good right away. This can't
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {(remove.isError || partial) && (
          <p role="alert" className="text-sm text-destructive">
            {partial ? failedText(partial, "deleted") : errorMessage(remove.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault(); // stay open until the API answers
              remove.mutate(photoIds, {
                onSuccess: (result) => {
                  if (result.failed.length > 0) return onPartial(result.done);
                  setConfirming(false);
                  onDone(`Deleted ${photosText(result.done.length)} forever.`);
                },
              });
            }}
          >
            {remove.isPending ? "Deleting…" : partial ? "Try again" : "Delete forever"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EmptyTrash({ count, onDone }: { count: number; onDone: (message: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const empty = useEmptyTrash();

  return (
    <AlertDialog
      open={confirming}
      onOpenChange={(open) => {
        if (empty.isPending) return;
        setConfirming(open);
        if (!open) empty.reset();
      }}
    >
      <Button variant="outline" onClick={() => setConfirming(true)}>
        Empty trash
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Empty the trash?</AlertDialogTitle>
          <AlertDialogDescription>
            All {photosText(count)} in the trash will be deleted for good right away. This can't be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {empty.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(empty.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={empty.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={empty.isPending}
            onClick={(event) => {
              event.preventDefault(); // stay open until the API answers
              empty.mutate(undefined, {
                onSuccess: () => {
                  setConfirming(false);
                  onDone("The trash is empty.");
                },
              });
            }}
          >
            {empty.isPending ? "Deleting…" : "Empty trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TrashError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </main>
  );
}
