import { createFileRoute } from "@tanstack/react-router";

// My albums + shared with me (FR-ALB-1, FR-SHR-3, 8.11/8.12).
export const Route = createFileRoute("/_authenticated/albums/")({
  component: Albums,
});

function Albums() {
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
    </main>
  );
}
