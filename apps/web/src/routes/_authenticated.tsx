import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

// Pathless layout for every signed-in page (§12.1, FR-AUTH-6): without a valid session (after a
// refresh attempt) go to /login, remembering the page. 8.5 builds the real layout.
export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.auth.getUser();
    if (!user) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { user };
  },
  component: AuthenticatedLayout,
});

const NAV = [
  { to: "/gallery", label: "Gallery" },
  { to: "/albums", label: "Albums" },
  { to: "/upload", label: "Upload" },
  { to: "/settings", label: "Settings" },
] as const;

function AuthenticatedLayout() {
  return (
    <>
      <nav className="flex gap-1 border-b p-2">
        {NAV.map(({ to, label }) => (
          <Button key={to} asChild variant="ghost" size="sm">
            <Link to={to} activeProps={{ "aria-current": "page", className: "bg-muted" }}>
              {label}
            </Link>
          </Button>
        ))}
      </nav>
      <div className="p-4">
        <Outlet />
      </div>
    </>
  );
}
