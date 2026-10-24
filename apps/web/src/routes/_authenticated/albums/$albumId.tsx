import { createFileRoute } from "@tanstack/react-router";

// Album view (FR-ALB-2, 8.11).
export const Route = createFileRoute("/_authenticated/albums/$albumId")({
  component: Album,
});

function Album() {
  const { albumId } = Route.useParams();
  return <main>Album {albumId}</main>;
}
