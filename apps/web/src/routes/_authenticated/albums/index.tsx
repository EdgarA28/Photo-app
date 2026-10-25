import type { Album } from "@photo-app/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { BookImage, Plus } from "lucide-react";
import { useState } from "react";
import { CreateAlbumDialog } from "@/albums/AlbumDialogs";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { albumsQuery } from "@/queries/albums";

// My albums (FR-ALB-1, 8.11); "Shared with me" comes with 8.12 (FR-SHR-3).
export const Route = createFileRoute("/_authenticated/albums/")({
  loader: ({ context }) =>
    context.queryClient.query({ ...albumsQuery(context.api), staleTime: "static" }),
  component: Albums,
  errorComponent: AlbumsError,
});

function Albums() {
  const { api } = Route.useRouteContext();
  const { data } = useSuspenseQuery(albumsQuery(api));
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // Newest first: album IDs are ULIDs, so the API lists them oldest first.
  const albums = [...data.items].reverse();

  return (
    <main className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          New album
        </Button>
      </header>

      {albums.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <BookImage aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">No albums yet.</p>
          <Button variant="outline" onClick={() => setCreating(true)}>
            Create your first album
          </Button>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {albums.map((album) => (
            <li key={album.albumId}>
              <AlbumCard album={album} />
            </li>
          ))}
        </ul>
      )}

      {/* Straight into the new album, ready to add photos. */}
      <CreateAlbumDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(album) =>
          void navigate({ to: "/albums/$albumId", params: { albumId: album.albumId } })
        }
      />
    </main>
  );
}

function AlbumCard({ album }: { album: Album }) {
  // Until Phase 7 the cover's thumbnail path doesn't load: keep the placeholder.
  const [broken, setBroken] = useState(false);
  return (
    <Link
      to="/albums/$albumId"
      params={{ albumId: album.albumId }}
      className="group block space-y-2 rounded-lg outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="grid aspect-square place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
        {album.coverThumbUrl && !broken ? (
          <img
            src={album.coverThumbUrl}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            className="size-full object-cover transition-transform group-hover:scale-[1.02]"
          />
        ) : (
          <BookImage aria-hidden className="size-8" />
        )}
      </div>
      <div>
        <p className="truncate text-sm font-medium">{album.name}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {album.photoCount === 1 ? "1 photo" : `${album.photoCount} photos`}
        </p>
      </div>
    </Link>
  );
}

function AlbumsError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </main>
  );
}
