import { createFileRoute, Outlet, redirect, useMatches } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import { useEffect } from "react";
import { BottomNav, SideNav } from "@/components/app-nav";
import { UsernamePrompt } from "@/settings/UsernamePrompt";
import { useOnline } from "@/upload/useUploads";

// Pathless layout for every signed-in page (§12.1, FR-AUTH-6): without a valid session (after a
// refresh attempt) go to /login, remembering the page.
export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.auth.getUser();
    if (!user) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { user };
  },
  component: AuthenticatedLayout,
});

// App shell (8.5): side rail from `md`, bottom tab bar below. Routes with `staticData.fullScreen`
// (the viewer, FR-GAL-4) get the whole screen.
function AuthenticatedLayout() {
  const { user, uploads } = Route.useRouteContext();
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
      <SideNav email={user.email} />
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
