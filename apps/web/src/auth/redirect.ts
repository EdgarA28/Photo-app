const DEFAULT_TARGET = "/gallery";

/**
 * Where to go after login. Only same-app paths are accepted (no `//host`, `/\host` or absolute
 * URLs: an open redirect would let a crafted login link send users to another site), and never
 * back to the login or callback pages.
 */
export function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) {
    return DEFAULT_TARGET;
  }
  const path = target.split(/[?#]/)[0]!;
  if (path === "/login" || path.startsWith("/auth/")) return DEFAULT_TARGET;
  return target;
}
