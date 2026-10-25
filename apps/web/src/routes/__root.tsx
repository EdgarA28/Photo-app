import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { Api } from "@/api/api";
import { errorMessage } from "@/api/errors";
import type { Auth } from "@/auth/auth";
import type { MediaCookies } from "@/auth/mediaCookie";
import { Button } from "@/components/ui/button";
import type { UploadQueue } from "@/upload/queue";

export interface RouterContext {
  queryClient: QueryClient;
  auth: Auth;
  api: Api;
  /** CloudFront cookies for the user's own images (7.3). */
  media: MediaCookies;
  /** App-wide, so uploads keep running while the user moves around (8.10). */
  uploads: UploadQueue;
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
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <Button onClick={() => window.location.reload()}>Try again</Button>
    </main>
  );
}
