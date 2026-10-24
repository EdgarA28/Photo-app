import { createFileRoute } from "@tanstack/react-router";

// Upload page / queue status (FR-UP-1/5/6, 8.10).
export const Route = createFileRoute("/_authenticated/upload")({
  component: Upload,
});

function Upload() {
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
    </main>
  );
}
