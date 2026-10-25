import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import type { LoginProvider } from "@/auth/auth";
import { safeRedirect } from "@/auth/redirect";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/configContext";

// FR-AUTH-1/2: Google, or email + password on Cognito's managed login (which also handles sign-up,
// email verification and forgotten passwords). `redirect` = page to return to after login;
// `reason=expired` = the API rejected the session (8.14), said so instead of a silent login page.
export const Route = createFileRoute("/login")({
  validateSearch: z.object({
    redirect: z.string().optional().catch(undefined),
    reason: z.enum(["expired"]).optional().catch(undefined),
  }),
  beforeLoad: async ({ context, search }) => {
    if (await context.auth.getUser()) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: Login,
});

function Login() {
  const { auth } = Route.useRouteContext();
  const { redirect, reason } = Route.useSearch();
  const { googleLogin } = useConfig();
  const [busy, setBusy] = useState(false);

  async function start(provider: LoginProvider) {
    setBusy(true);
    try {
      await auth.login({ provider, redirect });
    } catch (error) {
      setBusy(false);
      throw error;
    }
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-3 p-4">
      <h1 className="mb-4 text-center text-2xl font-semibold">Photo App</h1>
      {reason === "expired" && (
        <p role="status" className="mb-2 text-center text-sm text-muted-foreground">
          Your session has ended. Please log in again.
        </p>
      )}
      {googleLogin && (
        <Button size="lg" disabled={busy} onClick={() => void start("Google")}>
          Continue with Google
        </Button>
      )}
      <Button
        size="lg"
        variant={googleLogin ? "outline" : "default"}
        disabled={busy}
        onClick={() => void start("email")}
      >
        Continue with email
      </Button>
    </main>
  );
}
