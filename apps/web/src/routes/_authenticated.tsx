import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

// Pathless layout for every signed-in page (§12.1). 8.3 adds the `beforeLoad` session check
// (redirect to /login, FR-AUTH-6); 8.5 the real layout and navigation.
export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  return (
    <>
      <nav>
        <Link to="/gallery">Gallery</Link> <Link to="/albums">Albums</Link>{" "}
        <Link to="/upload">Upload</Link> <Link to="/settings">Settings</Link>
      </nav>
      <Outlet />
    </>
  );
}
