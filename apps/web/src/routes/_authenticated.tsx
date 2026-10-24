import { createFileRoute, Outlet, redirect, useMatches } from "@tanstack/react-router";
import { BottomNav, SideNav } from "@/components/app-nav";

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
  const { user } = Route.useRouteContext();
  const fullScreen = useMatches({
    select: (matches) => matches.some((m) => m.staticData.fullScreen),
  });

  if (fullScreen) return <Outlet />;
  return (
    <div className="flex min-h-svh">
      <SideNav email={user.email} />
      <div className="min-w-0 flex-1 px-4 pt-5 pb-[calc(5rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-8">
        <Outlet />
      </div>
      <BottomNav />
    </div>
  );
}
