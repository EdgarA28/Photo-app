const DEFAULT_TARGET = "/gallery";

/** Only used to resolve the target; the origin check works the same on any real origin. */
const BASE = "https://app.invalid";

/** URL parsing drops tabs and newlines (`/\t/host` → `//host`), so no control characters. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Where to go after login. Only same-app paths are accepted (no `//host`, `/\host`, absolute
 * URLs or variants hidden by control characters: an open redirect would let a crafted login link
 * send users to another site; 12.2c), and never back to the login or callback pages.
 */
export function safeRedirect(target: string | undefined): string {
  if (
    !target ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    CONTROL_CHARACTERS.test(target)
  ) {
    return DEFAULT_TARGET;
  }
  // Whatever slipped past the checks above must still resolve to this app.
  const url = new URL(target, BASE);
  if (url.origin !== BASE) return DEFAULT_TARGET;
  if (url.pathname === "/login" || url.pathname.startsWith("/auth/")) return DEFAULT_TARGET;
  return target;
}
