import { createFileRoute, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Library } from "@/gallery/Library";
import { libraryFilter } from "@/gallery/library";
import { gallerySearchSchema } from "@/gallery/search";
import { galleryQuery } from "@/queries/photos";

/**
 * The Videos section (FR-VID-11, user request 2026-11-04): own videos by date taken, apart from
 * the photos of the Gallery. Same page as the Gallery (`Library`), without the place search.
 */
export const Route = createFileRoute("/_authenticated/videos")({
  validateSearch: gallerySearchSchema,
  loaderDeps: ({ search }) => libraryFilter("video", search),
  loader: ({ context, deps }) =>
    context.queryClient.infiniteQuery({ ...galleryQuery(context.api, deps), staleTime: "static" }),
  component: Videos,
  errorComponent: VideosError,
});

function Videos() {
  const { api } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  return (
    <Library
      kind="video"
      api={api}
      search={Route.useSearch()}
      setSearch={(change) => void navigate({ search: change })}
    />
  );
}

// No network, or the API failing.
function VideosError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Videos</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </main>
  );
}
