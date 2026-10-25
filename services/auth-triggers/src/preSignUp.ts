import type { PoolDirectory, PoolUser } from "./directory";
import { errorFields, log } from "./log";

/** The parts of the Cognito pre sign-up event this trigger reads (and returns unchanged). */
export interface PreSignUpEvent {
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: { userAttributes: Record<string, string | undefined> };
  response: Record<string, unknown>;
}

/** Identity providers that may be linked to a native user. Must match the IdP names in infra. */
const LINKABLE_PROVIDERS = ["Google"];

/** Sign-ups a user starts themselves; `PreSignUp_AdminCreateUser` is an admin's choice. */
const SELF_SIGN_UPS = ["PreSignUp_SignUp", "PreSignUp_ExternalProvider"];

/** Shown by the hosted sign-up page (Cognito prefixes "PreSignUp failed with error "). */
export const EMAIL_TAKEN_MESSAGE =
  "An account with this email already exists. Sign in with Google instead.";

/** Shown when the email isn't on the allowlist (hosted sign-up page, or the app's callback page). */
export const NOT_INVITED_MESSAGE = "Sign-up is by invitation only.";

export interface PreSignUpOptions {
  /**
   * Who may create an account (deviation from FR-AUTH-1 while the app isn't public, see
   * ARCHITECTURE §15). Null = anyone. Admin-created users aren't checked.
   */
  allowedEmails?: ReadonlySet<string> | null;
}

/** `ALLOWED_EMAILS` ("a@x.com,b@y.com") → lowercase set; unset or blank = no allowlist. */
export function parseAllowedEmails(value: string | undefined): ReadonlySet<string> | null {
  const emails = (value ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return emails.length > 0 ? new Set(emails) : null;
}

/**
 * Pre sign-up trigger (spec §11.3): keeps one account per verified email.
 *
 * - With an allowlist, email/password and Google sign-ups for any other email are refused
 *   first, and so are Google sign-ups whose email Google hasn't verified. Email/password
 *   sign-ups still need the emailed code, so an allowed address can't be claimed by someone else.
 * - Google sign-up (`PreSignUp_ExternalProvider`) whose verified email belongs to exactly one
 *   confirmed native user: link the Google identity to that user (`AdminLinkProviderForUser`),
 *   so both sign-in methods give the same `sub` and the same photos (FR-AUTH-3).
 * - Email/password sign-up (`PreSignUp_SignUp`) for an email that a verified user (a Google
 *   user, since Cognito already rejects duplicate native emails) has: refuse it. The reverse
 *   link isn't possible because the native user doesn't exist yet, and a second account would
 *   split the user's photos and make the email unusable for sharing (5.12 never guesses).
 * - Anything else passes through.
 */
export function createPreSignUpHandler(
  directory: PoolDirectory,
  { allowedEmails = null }: PreSignUpOptions = {},
) {
  return async function handler(event: PreSignUpEvent): Promise<PreSignUpEvent> {
    if (allowedEmails && SELF_SIGN_UPS.includes(event.triggerSource)) {
      const attributes = event.request.userAttributes;
      const email = normaliseEmail(attributes.email);
      // A Google sign-up is never confirmed by our own code, so only an address Google verified
      // proves it belongs to the person (email/password sign-ups still need the emailed code).
      const unverifiedExternal =
        event.triggerSource === "PreSignUp_ExternalProvider" &&
        attributes.email_verified !== "true";
      if (!email || !allowedEmails.has(email) || unverifiedExternal) {
        log("INFO", "Refused sign-up: email not on the allowlist", {
          triggerSource: event.triggerSource,
        });
        throw new Error(NOT_INVITED_MESSAGE);
      }
    }
    if (event.triggerSource === "PreSignUp_ExternalProvider") await linkToNativeUser(event);
    else if (event.triggerSource === "PreSignUp_SignUp") await refuseTakenEmail(event);
    return event;
  };

  async function linkToNativeUser(event: PreSignUpEvent): Promise<void> {
    const identity = parseExternalUserName(event.userName);
    if (!identity) {
      log("INFO", "Sign-up from a provider that isn't linked", { userName: event.userName });
      return;
    }
    const attributes = event.request.userAttributes;
    // Only an address the provider verified proves ownership; linking on an unverified one would
    // hand the native account to whoever typed its email.
    if (attributes.email_verified !== "true") {
      log("INFO", "External email not verified; not linking", { provider: identity.provider });
      return;
    }
    const email = normaliseEmail(attributes.email);
    if (!email) return;

    const natives = (await directory.findByEmail(event.userPoolId, email)).filter(isLinkTarget);
    if (natives.length === 0) return; // New user: Cognito creates the Google user as usual.
    if (natives.length > 1) {
      // Should be impossible (native emails are unique); never guess between two accounts.
      log("WARN", "Several native users share a verified email; not linking", {
        provider: identity.provider,
        usernames: natives.map((u) => u.username),
      });
      return;
    }

    const target = natives[0]!;
    try {
      await directory.linkProvider(
        event.userPoolId,
        target.username,
        identity.provider,
        identity.providerUserId,
      );
    } catch (err) {
      // Failing the sign-up is better than silently creating a second account for the same person.
      log("ERROR", "Linking failed", { provider: identity.provider, ...errorFields(err) });
      throw err;
    }
    log("INFO", "Linked external identity to native user", {
      provider: identity.provider,
      username: target.username,
    });
  }

  async function refuseTakenEmail(event: PreSignUpEvent): Promise<void> {
    const email = normaliseEmail(event.request.userAttributes.email);
    if (!email) return;
    const users = await directory.findByEmail(event.userPoolId, email);
    if (users.some((u) => u.enabled && u.emailVerified && u.status === "EXTERNAL_PROVIDER")) {
      log("INFO", "Refused email sign-up: a federated user has this email");
      throw new Error(EMAIL_TAKEN_MESSAGE);
    }
  }
}

/** `Google_1234…` → `{ provider: "Google", providerUserId: "1234…" }`; null for other providers. */
export function parseExternalUserName(
  userName: string,
): { provider: string; providerUserId: string } | null {
  const separator = userName.indexOf("_");
  if (separator <= 0 || separator === userName.length - 1) return null;
  // The pool is case-insensitive, so don't rely on the prefix's case.
  const prefix = userName.slice(0, separator).toLowerCase();
  const provider = LINKABLE_PROVIDERS.find((p) => p.toLowerCase() === prefix);
  return provider ? { provider, providerUserId: userName.slice(separator + 1) } : null;
}

/** Trimmed, lowercase; null if missing or unsafe to put into a ListUsers filter string. */
function normaliseEmail(email: string | undefined): string | null {
  const value = email?.trim().toLowerCase();
  if (!value || /["\\]/.test(value)) return null;
  return value;
}

/** A native user who has proven the email and can sign in. */
function isLinkTarget(user: PoolUser): boolean {
  return user.status === "CONFIRMED" && user.enabled && user.emailVerified;
}
