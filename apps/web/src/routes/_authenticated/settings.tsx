import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { meQuery } from "@/queries/me";

// Usage, quota, logout (FR-ACC-1, FR-AUTH-5). 8.13 adds the quota bar, username and clearing the
// media cookie, Query cache and IndexedDB on logout.
export const Route = createFileRoute("/_authenticated/settings")({
  loader: ({ context }) =>
    context.queryClient.query({ ...meQuery(context.api), staleTime: "static" }),
  component: Settings,
});

function Settings() {
  const { auth, api } = Route.useRouteContext();
  const { data: me } = useSuspenseQuery(meQuery(api));
  const [busy, setBusy] = useState(false);

  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p>
        Signed in as <span className="font-medium">{me.email}</span>
      </p>
      <p>
        {formatBytes(me.usage.bytesUsed)} of {formatBytes(me.usage.quotaBytes)} used ·{" "}
        {me.usage.photoCount} {me.usage.photoCount === 1 ? "photo" : "photos"}
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
