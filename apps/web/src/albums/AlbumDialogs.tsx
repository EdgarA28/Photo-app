import type { Album } from "@photo-app/shared";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateAlbum, useDeleteAlbum, useUpdateAlbum } from "@/queries/albums";
import { AlbumNameForm } from "./AlbumNameForm";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const cancel = (
  <DialogClose asChild>
    <Button type="button" variant="outline">
      Cancel
    </Button>
  </DialogClose>
);

/** "New album" (FR-ALB-1). */
export function CreateAlbumDialog({
  open,
  onOpenChange,
  onCreated,
}: DialogProps & { onCreated: (album: Album) => void }) {
  const create = useCreateAlbum();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) create.reset();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New album</DialogTitle>
        </DialogHeader>
        {/* Remounted per opening, so the field starts empty. */}
        {open && (
          <AlbumNameForm
            submitLabel="Create"
            pendingLabel="Creating…"
            isPending={create.isPending}
            error={create.error}
            secondary={cancel}
            onSubmit={(name) =>
              create.mutate(name, {
                onSuccess: (album) => {
                  onOpenChange(false);
                  onCreated(album);
                },
              })
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RenameAlbumDialog({ album, open, onOpenChange }: DialogProps & { album: Album }) {
  const update = useUpdateAlbum(album.albumId);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) update.reset();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Rename album</DialogTitle>
        </DialogHeader>
        {open && (
          <AlbumNameForm
            initialName={album.name}
            submitLabel="Save"
            pendingLabel="Saving…"
            isPending={update.isPending}
            error={update.error}
            secondary={cancel}
            onSubmit={(name) => {
              if (name === album.name) return onOpenChange(false);
              update.mutate({ name }, { onSuccess: () => onOpenChange(false) });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Deletes the album only; its photos stay in the library (FR-ALB-1). */
export function DeleteAlbumDialog({
  album,
  open,
  onOpenChange,
  onDeleted,
}: DialogProps & { album: Album; onDeleted: () => Promise<void> | void }) {
  const remove = useDeleteAlbum(album.albumId, { beforeCacheUpdate: onDeleted });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (remove.isPending) return;
        onOpenChange(next);
        if (!next) remove.reset();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this album?</AlertDialogTitle>
          <AlertDialogDescription>
            “{album.name}” will be deleted. The photos in it stay in your library.
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
            {remove.isPending ? "Deleting…" : "Delete album"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
