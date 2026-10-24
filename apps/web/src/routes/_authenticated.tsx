import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

// Pathless layout for every signed-in page (§12.1). 8.3 adds the `beforeLoad` session check
// (redirect to /login, FR-AUTH-6); 8.5 the real layout and navigation.
export const Route = createFileRoute("/_authenticated")({
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
