import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { Auth } from "@/auth/auth";
import { Button } from "@/components/ui/button";

export interface RouterContext {
  queryClient: QueryClient;
  auth: Auth;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function NotFound() {
  return (
    <main className="p-4">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link to="/gallery">Back to the gallery</Link>
    </main>
  );
}

// e.g. no network while refreshing the session; a reload retries.
function RootError({ error }: ErrorComponentProps) {
  return (
    <main className="space-y-3 p-4">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button onClick={() => window.location.reload()}>Try again</Button>
    </main>
  );
}
