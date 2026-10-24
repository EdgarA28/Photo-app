import { createFileRoute, Link, redirect, type ErrorComponentProps } from "@tanstack/react-router";
import { ErrorResponse } from "oidc-client-ts";
import { Button } from "@/components/ui/button";

// OAuth redirect target (§11): oidc-client-ts checks `state`, exchanges `?code=` + PKCE verifier
// for tokens, then we continue to the page the login started from. Runs once per visit: the
// login state is deleted when used, so a reload or a replayed URL ends on the error page.
export const Route = createFileRoute("/auth/callback")({
  loader: async ({ context }) => {
    throw redirect({ href: await context.auth.completeLogin(), replace: true });
  },
  pendingComponent: () => <main className="p-4">Signing in…</main>,
  errorComponent: CallbackError,
});

function CallbackError({ error }: ErrorComponentProps) {
  return (
    <main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-3 p-4 text-center">
      <h1 className="text-xl font-semibold">Sign-in didn't complete</h1>
      <p className="text-muted-foreground">{describe(error)}</p>
      <Button asChild>
        <Link to="/login">Try again</Link>
      </Button>
    </main>
  );
}

function describe(error: unknown): string {
  // Cognito error redirects (`?error=access_denied`, …) arrive as oidc-client-ts ErrorResponse.
  if (error instanceof ErrorResponse && error.error === "access_denied") {
    return "The sign-in was cancelled.";
  }
  return error instanceof Error ? error.message : String(error);
}
