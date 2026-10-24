import { vi } from "vitest";
import { createApi } from "../src/api/api";
import type { Request, RequestOptions } from "../src/api/client";
import type { Auth, SessionUser } from "../src/auth/auth";
import type { AppConfig } from "../src/config";

export const testConfig: AppConfig = {
  origin: "http://localhost:5173",
  cognito: {
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST",
    clientId: "test-client",
    domain: "https://photo-app-test.auth.us-east-1.amazoncognito.com",
  },
  googleLogin: true,
};

export const testUser: SessionUser = {
  sub: "04e8b4b8-0000-4000-8000-000000000001",
  email: "user@example.com",
  name: "Test User",
};

/** Auth with a switchable session; methods are spies. */
export function fakeAuth(options: { signedIn?: boolean; callbackTarget?: string } = {}) {
  let user: SessionUser | null = options.signedIn ? testUser : null;
  const auth = {
    getUser: vi.fn(async () => user),
    getAccessToken: vi.fn(async () => (user ? "access-token" : null)),
    refreshAccessToken: vi.fn(async () => (user ? "access-token-2" : null)),
    login: vi.fn(async () => {}),
    completeLogin: vi.fn(async () => {
      user = testUser;
      return options.callbackTarget ?? "/gallery";
    }),
    clearSession: vi.fn(async () => {
      user = null;
    }),
    logout: vi.fn(async () => {
      user = null;
    }),
  } satisfies Auth;
  return auth;
}

/** Minimal Web Storage (a separate sessionStorage per simulated tab). */
export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

/**
 * Api backed by a table of canned responses keyed by "METHOD /path" (no query string). Responses
 * still go through the route's schema, as in the real client.
 */
export function fakeApi(responses: Record<string, unknown> = {}) {
  const request = vi.fn(
    async (method: string, path: string, options: RequestOptions<unknown> = {}) => {
      const key = `${method} ${path}`;
      if (!(key in responses)) throw new Error(`fakeApi: no response for ${key}`);
      const value = responses[key];
      if (value instanceof Error) throw value;
      return options.schema ? options.schema.parse(value) : undefined;
    },
  );
  return { api: createApi(request as Request), request };
}

export const testMe = {
  userId: testUser.sub,
  email: "user@example.com",
  name: "Test User",
  username: null,
  usage: { bytesUsed: 1536 * 1024, photoCount: 3, quotaBytes: 2 * 1024 ** 3 },
};
