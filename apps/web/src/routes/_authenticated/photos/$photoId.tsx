import { createFileRoute } from "@tanstack/react-router";

// Full-screen viewer (FR-GAL-4, 8.8).
export const Route = createFileRoute("/_authenticated/photos/$photoId")({
  component: Viewer,
});

function Viewer() {
  const { photoId } = Route.useParams();
  return <main>Photo {photoId}</main>;
}
