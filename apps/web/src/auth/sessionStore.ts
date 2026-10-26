import type { StateStore } from "oidc-client-ts";
import type { SessionDb } from "./sessionDb";

/** Key prefix of sessions stored in localStorage before 9.5; moved to the SessionDb on read. */
const LEGACY_PREFIX = "photo-app.session.";

/**
 * oidc-client-ts user store (spec §11.4, decided 2026-10-24 as option A): the full session (access
 * and ID tokens, profile) lives only in memory; just the refresh token is written to persistent
 * storage, so a restarted tab or PWA can get fresh tokens without a login (FR-AUTH-4). With it the
 * user's `sub` (an opaque ID; no email or name): offline the app can't refresh, but still needs to
 * know whose saved data to show (9.3, FR-PWA-2). Persistent storage is IndexedDB since 9.5, so the
 * service worker can upload in the background (see sessionDb.ts).
 *
 * After a restart `get` returns a session without an access token that is already expired, which
 * makes the auth service refresh it before use.
 */
export class SessionStore implements StateStore {
  private readonly memory = new Map<string, string>();

  constructor(
    private readonly persistent: SessionDb,
    /** localStorage: a session stored there by an older version is moved over (9.5). */
    private readonly legacy?: Storage,
  ) {}

  async set(key: string, value: string): Promise<void> {
    this.memory.set(key, value);
    const { refresh_token, scope, token_type, profile } = JSON.parse(value) as {
      refresh_token?: unknown;
      scope?: unknown;
      token_type?: unknown;
      profile?: { sub?: unknown };
    };
    if (typeof refresh_token === "string") {
      const sub = typeof profile?.sub === "string" ? profile.sub : undefined;
      await this.persistent.set(
        key,
        JSON.stringify({ refresh_token, scope, token_type, expires_at: 0, profile: { sub } }),
      );
    } else {
      await this.persistent.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    const value = this.memory.get(key) ?? (await this.persistent.get(key));
    if (value !== undefined) return value;
    const legacy = this.legacy?.getItem(LEGACY_PREFIX + key);
    if (!legacy) return null;
    await this.persistent.set(key, legacy);
    this.legacy!.removeItem(LEGACY_PREFIX + key);
    return legacy;
  }

  async remove(key: string): Promise<string | null> {
    const value = await this.get(key);
    this.memory.delete(key);
    await this.persistent.delete(key);
    return value;
  }

  async getAllKeys(): Promise<string[]> {
    const legacy = this.legacy
      ? Array.from({ length: this.legacy.length }, (_, i) => this.legacy!.key(i))
          .filter((key) => key?.startsWith(LEGACY_PREFIX))
          .map((key) => key!.slice(LEGACY_PREFIX.length))
      : [];
    return [...new Set([...this.memory.keys(), ...(await this.persistent.keys()), ...legacy])];
  }
}
