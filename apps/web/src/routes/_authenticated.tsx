import { createFileRoute, Outlet, redirect, useMatches } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { BottomNav, SideNav } from "@/components/app-nav";
import { meQuery } from "@/queries/me";
import { useRemoteChanges } from "@/queries/remoteChanges";
import { UsernamePrompt } from "@/settings/UsernamePrompt";
import { useOnline } from "@/upload/useUploads";

// Pathless layout for every signed-in page (§12.1, FR-AUTH-6): without a session go to /login,
// remembering the page. The stored session's user is enough to open the app (8.25b): the guard
// doesn't wait for Cognito, so the app starts as fast as the saved data loads, online or offline
// (9.3, FR-PWA-2). Nothing new loads without a token anyway: the first API call waits for the
// refresh, and if Cognito rejects it, `onUnauthorized` (main.tsx) ends the session. Without a
// stored session, `getUser` decides (a network error shows the error page). That user's saved
// Query cache is restored before any loader reads the cache. Pages render only once the browser
// holds media cookies for this user (7.3), so the first images don't fail with 403: the ones
// issued on an earlier start if they're still valid (8.25c, renewed in the background), else new
// ones, which wait for the token refresh. ready() never throws and runs alongside the restore.
export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context, location }) => {
    const user = (await context.auth.getStoredUser()) ?? (await context.auth.getUser());
    if (!user) {
      // The session ended without a logout (refresh token rejected, API rejected the token):
      // the saved data goes too (FR-AUTH-5). Without a session there is nothing to delete.
      await context.persistedCache
        .clear()
        .catch((error: unknown) => console.warn("Deleting the saved query cache failed", error));
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    await Promise.all([context.persistedCache.start(user.sub), context.media.ready(user.sub)]);
    return { user };
  },
  component: AuthenticatedLayout,
});

// App shell (8.5): side rail from `md`, bottom tab bar below. Routes with `staticData.fullScreen`
// (the viewer, FR-GAL-4) get the whole screen.
function AuthenticatedLayout() {
  const { user, uploads, api } = Route.useRouteContext();
  useRemoteChanges(api);
  // The stored session has no email (8.25b), so the side rail takes it from /me (polled by
  // useRemoteChanges, and saved with the cache, so it's there offline too).
  const { data: me } = useQuery(meQuery(api));
  // The upload queue runs while signed in (8.10). Stopped when the session ends, so it doesn't
  // keep hitting the API with a dead session; the stored queue resumes on the next login.
  useEffect(() => {
    void uploads.start(user.sub);
    return () => uploads.stop();
  }, [uploads, user.sub]);
  const fullScreen = useMatches({
    select: (matches) => matches.some((m) => m.staticData.fullScreen),
  });

  if (fullScreen) return <Outlet />;
  return (
    <div className="flex min-h-svh">
      <SideNav email={me?.email ?? user.email} />
      <div className="min-w-0 flex-1 px-4 pt-5 pb-[calc(5rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-8">
        <OfflineBanner />
        <Outlet />
      </div>
      <UsernamePrompt key={user.sub} userId={user.sub} />
      <BottomNav />
    </div>
  );
}

/** While the browser is offline (8.14): pages can't load new data, so say why. */
function OfflineBanner() {
  if (useOnline()) return null;
  return (
    <p
      role="status"
      className="mb-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      <WifiOff aria-hidden className="size-4 shrink-0" />
      You're offline. Some things won't load until you're back online.
    </p>
  );
}
