import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { MapPinOff } from "lucide-react";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { PhotoMap } from "@/map/PhotoMap";
import { photoLocationsQuery } from "@/queries/places";

// Map of the user's photos (13.2h, FR-SRCH-5). The route's component is split into its own chunk
// (autoCodeSplitting), so MapLibre only loads when the map is opened.
export const Route = createFileRoute("/_authenticated/map")({
  loader: ({ context }) =>
    context.queryClient.query({ ...photoLocationsQuery(context.api), staleTime: "static" }),
  component: MapPage,
  errorComponent: MapError,
});

function MapPage() {
  const { api } = Route.useRouteContext();
  const { data } = useSuspenseQuery(photoLocationsQuery(api));
  const navigate = Route.useNavigate();

  return (
    <main className="flex h-[calc(100svh-6.25rem-env(safe-area-inset-bottom))] flex-col gap-4 md:h-[calc(100svh-4rem)]">
      <h1 className="text-2xl font-semibold tracking-tight">Map</h1>
      {data.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <MapPinOff aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">No photos with a location yet.</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Photos show up here when the camera saved where they were taken.
          </p>
        </div>
      ) : (
        <PhotoMap
          photos={data.items}
          // In its town's list, so prev/next walk the photos of that place, as after a search.
          onOpen={({ photoId, placeId }) =>
            void navigate({
              to: "/photos/$photoId",
              params: { photoId },
              search: { place: placeId ?? undefined },
            })
          }
          className="min-h-0 flex-1 overflow-hidden rounded-lg border"
        />
      )}
    </main>
  );
}

function MapError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Map</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void router.invalidate()}>
          Try again
        </Button>
        <Button asChild variant="ghost">
          <Link to="/gallery">Gallery</Link>
        </Button>
      </div>
    </main>
  );
}
