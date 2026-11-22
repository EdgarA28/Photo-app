import { GOOGLE_IMPORT_CALLBACK_PATH, GOOGLE_PHOTOS_PICKER_SCOPE } from "@photo-app/shared";

/**
 * Google's consent for the Photos Picker scope (13.5g; FR-IMP-1, §11.5, NFR-SEC-10): authorization
 * code + PKCE, asked only when an import starts, separately from login. The browser only ever sees
 * the code; the API exchanges it (with the client secret) and keeps the token.
 *
 * `state` and the PKCE verifier wait in sessionStorage for the redirect back, so they live in this
 * tab only and are used once: `takeGoogleConsent` deletes them whatever the outcome.
 */

const STORAGE_KEY = "photo-app:google-import-consent";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** A consent older than this is stale (Google's codes last minutes). */
const MAX_AGE_MS = 15 * 60 * 1000;

interface PendingConsent {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

export const importRedirectUri = (origin: string) => `${origin}${GOOGLE_IMPORT_CALLBACK_PATH}`;

export interface ConsentDeps {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  navigate?: (url: string) => void;
  now?: () => number;
}

/** Sends the browser to Google's consent screen. */
export async function startGoogleConsent(
  { clientId, origin, loginHint }: { clientId: string; origin: string; loginHint?: string },
  deps: ConsentDeps = {},
): Promise<void> {
  const storage = deps.storage ?? window.sessionStorage;
  const navigate = deps.navigate ?? ((url: string) => window.location.assign(url));
  const state = randomString(32);
  // RFC 7636: 43–128 characters; 48 random bytes → 64.
  const codeVerifier = randomString(48);
  const pending: PendingConsent = { state, codeVerifier, createdAt: (deps.now ?? Date.now)() };
  storage.setItem(STORAGE_KEY, JSON.stringify(pending));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: importRedirectUri(origin),
    response_type: "code",
    scope: GOOGLE_PHOTOS_PICKER_SCOPE,
    state,
    code_challenge: await sha256Base64Url(codeVerifier),
    code_challenge_method: "S256",
    // No refresh token: the import needs the token for about an hour at most (§11.5).
    access_type: "online",
    // Only this permission, not the ones of earlier grants (login's openid/email/profile).
    include_granted_scopes: "false",
  });
  // Preselects the account the user is signed in with; they can still pick another.
  if (loginHint) params.set("login_hint", loginHint);
  navigate(`${GOOGLE_AUTHORIZE_URL}?${params}`);
}

export type ConsentResult =
  | { kind: "ok"; code: string; codeVerifier: string }
  | { kind: "cancelled" }
  | { kind: "invalid"; reason: string };

/**
 * Reads Google's redirect (`?code&state` or `?error`) against the stored consent and forgets it.
 * A missing, foreign, stale or reused `state` is refused (CSRF, NFR-SEC-10).
 */
export function takeGoogleConsent(search: URLSearchParams, deps: ConsentDeps = {}): ConsentResult {
  const storage = deps.storage ?? window.sessionStorage;
  const raw = storage.getItem(STORAGE_KEY);
  storage.removeItem(STORAGE_KEY);

  if (search.get("error") === "access_denied") return { kind: "cancelled" };
  if (search.has("error")) return { kind: "invalid", reason: "Google reported an error" };
  const pending = parse(raw);
  if (!pending) return { kind: "invalid", reason: "This import wasn't started in this tab" };
  if ((deps.now ?? Date.now)() - pending.createdAt > MAX_AGE_MS) {
    return { kind: "invalid", reason: "This import was started too long ago" };
  }
  const code = search.get("code");
  if (!code || search.get("state") !== pending.state) {
    return { kind: "invalid", reason: "The answer from Google doesn't match this import" };
  }
  return { kind: "ok", code, codeVerifier: pending.codeVerifier };
}

function parse(raw: string | null): PendingConsent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingConsent>;
    if (
      typeof value.state === "string" &&
      typeof value.codeVerifier === "string" &&
      typeof value.createdAt === "number"
    ) {
      return value as PendingConsent;
    }
  } catch {
    // Not ours.
  }
  return null;
}

function randomString(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
