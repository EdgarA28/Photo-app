import { createFileRoute } from "@tanstack/react-router";

// FR-AUTH-1: Google + email login via Cognito managed login (8.3).
export const Route = createFileRoute("/login")({
  component: Login,
});

function Login() {
  return (
    <main>
      <h1>Log in</h1>
    </main>
  );
}
