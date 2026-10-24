import { createFileRoute } from "@tanstack/react-router";

// OAuth redirect target: exchanges `?code=` (+ PKCE verifier) for tokens (8.3).
export const Route = createFileRoute("/auth/callback")({
  component: Callback,
});

function Callback() {
  return <main>Signing in…</main>;
}
