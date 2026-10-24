import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Usage, quota, logout (FR-ACC-1, FR-AUTH-5). 8.13 adds usage/quota and clearing the media
// cookie, Query cache and IndexedDB on logout.
export const Route = createFileRoute("/_authenticated/settings")({
  component: Settings,
});

function Settings() {
  const { auth, user } = Route.useRouteContext();
  const [busy, setBusy] = useState(false);

  return (
    <main className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p>
        Signed in as <span className="font-medium">{user.email ?? user.name ?? user.sub}</span>
      </p>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void auth.logout();
        }}
      >
        Log out
      </Button>
    </main>
  );
}
