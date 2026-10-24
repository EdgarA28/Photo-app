import { createFileRoute } from "@tanstack/react-router";

// Usage, quota, logout (FR-ACC-1, FR-AUTH-5, 8.13).
export const Route = createFileRoute("/_authenticated/settings")({
  component: Settings,
});

function Settings() {
  return (
    <main>
      <h1>Settings</h1>
    </main>
  );
}
