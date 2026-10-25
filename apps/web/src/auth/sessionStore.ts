import type { StateStore } from "oidc-client-ts";

const PREFIX = "photo-app.session.";

/**
 * oidc-client-ts user store (spec §11.4, decided 2026-10-24 as option A): the full session (access
 * and ID tokens, profile) lives only in memory; just the refresh token is written to localStorage,
 * so a restarted tab or PWA can get fresh tokens without a login (FR-AUTH-4). With it the user's
 * `sub` (an opaque ID; no email or name): offline the app can't refresh, but still needs to know
 * whose saved data to show (9.3, FR-PWA-2).
 *
 * After a restart `get` returns a session without an access token that is already expired, which
 * makes the auth service refresh it before use.
 */
export class SessionStore implements StateStore {
  private readonly memory = new Map<string, string>();

  constructor(private readonly persistent: Storage) {}

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
      this.persistent.setItem(
        PREFIX + key,
        JSON.stringify({ refresh_token, scope, token_type, expires_at: 0, profile: { sub } }),
      );
    } else {
      this.persistent.removeItem(PREFIX + key);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.memory.get(key) ?? this.persistent.getItem(PREFIX + key);
  }

  async remove(key: string): Promise<string | null> {
    const value = await this.get(key);
    this.memory.delete(key);
    this.persistent.removeItem(PREFIX + key);
    return value;
  }

  async getAllKeys(): Promise<string[]> {
    const persisted = Array.from({ length: this.persistent.length }, (_, i) =>
      this.persistent.key(i),
    )
      .filter((key) => key?.startsWith(PREFIX))
      .map((key) => key!.slice(PREFIX.length));
    return [...new Set([...this.memory.keys(), ...persisted])];
  }
}
