import type { Album } from "@photo-app/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { BookImage, Plus, Users } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { albumsQuery, useAddToAlbum, useCreateAlbum } from "@/queries/albums";
import { sharedAlbumsQuery } from "@/queries/shares";
import { AlbumNameForm } from "./AlbumNameForm";

const photosText = (count: number) => (count === 1 ? "1 photo" : `${count} photos`);

/**
 * Picks an album for one or more photos, or creates one, and adds them (FR-ALB-2). Albums shared
 * with me are offered too while their owner lets members add photos (FR-SHR-9; only the pages of
 * "Shared with me" already loaded, usually all of them). There is no route listing a photo's
 * albums, so albums aren't ticked; adding is idempotent anyway.
 */
export function AddToAlbumDialog({
  photoIds,
  open,
  onOpenChange,
  onAdded,
}: {
  photoIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (album: Album) => void;
}) {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const { data, isPending, isError, error } = useQuery({ ...albumsQuery(api), enabled: open });
  const shared = useInfiniteQuery({ ...sharedAlbumsQuery(api), enabled: open });
  const openToMe = (shared.data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((album) => album.membersCanAdd);
  const add = useAddToAlbum();
  const create = useCreateAlbum();
  const [creating, setCreating] = useState(false);

  function addTo(album: Album) {
    add.mutate(
      { albumId: album.albumId, photoIds },
      {
        onSuccess: () => {
          onOpenChange(false);
          onAdded(album);
        },
      },
    );
  }

  function close(next: boolean) {
    if (add.isPending || create.isPending) return;
    onOpenChange(next);
    if (!next) {
      add.reset();
      create.reset();
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{creating ? "New album" : "Add to album"}</DialogTitle>
          <DialogDescription>
            {creating
              ? `The ${photosText(photoIds.length)} will be added to it.`
              : `Choose an album for ${photosText(photoIds.length)}.`}
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <AlbumNameForm
            submitLabel="Create and add"
            pendingLabel="Adding…"
            isPending={create.isPending || add.isPending}
            error={create.error ?? add.error}
            secondary={
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                Back
              </Button>
            }
            onSubmit={(name) => create.mutate(name, { onSuccess: addTo })}
          />
        ) : (
          <>
            {isPending && <p className="text-muted-foreground">Loading albums…</p>}
            {isError && (
              <p role="alert" className="text-destructive">
                {errorMessage(error)}
              </p>
            )}
            {data && (
              <ul className="-mx-1 max-h-72 overflow-y-auto">
                {[...data.items, ...openToMe].map((album) => (
                  <li key={album.albumId}>
                    <button
                      type="button"
                      disabled={add.isPending}
                      onClick={() => addTo(album)}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                    >
                      {"ownerId" in album ? (
                        <Users
                          aria-label="Shared with you"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      ) : (
                        <BookImage aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">{album.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {album.photoCount}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {add.isError && (
              <p role="alert" className="text-destructive">
                {errorMessage(add.error)}
              </p>
            )}
            <Button
              variant="outline"
              disabled={add.isPending}
              onClick={() => setCreating(true)}
              className="justify-self-start"
            >
              <Plus aria-hidden />
              New album
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
