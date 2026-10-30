import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth, type Auth } from "../src/auth/auth";
import { readStoredSession } from "../src/auth/sessionDb";
import { MemorySessionDb, MemoryStorage, testConfig, testUser } from "./fakes";

const { domain, clientId, issuer } = testConfig.cognito;
const TOKEN_URL = `${domain}/oauth2/token`;
const REVOKE_URL = `${domain}/oauth2/revoke`;

/** Unsigned JWT: oidc-client-ts only decodes ID tokens (API Gateway verifies access tokens). */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

const idToken = jwt({
  sub: testUser.sub,
  email: testUser.email,
  name: testUser.name,
  iss: issuer,
  aud: clientId,
  token_use: "id",
  auth_time: 1_700_000_000,
});

function tokenResponse(extra: Record<string, unknown> = {}) {
  return Response.json({
    access_token: "access-1",
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3600,
    ...extra,
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let persistent: MemorySessionDb;
let legacy: MemoryStorage;
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;

/** A tab: own memory + sessionStorage, shared session database (`persistent`). */
function openTab(): Auth {
  return createAuth(testConfig, {
    sessionDb: persistent,
    legacyStorage: legacy,
    requestStorage: new MemoryStorage(),
    navigate,
  });
}

function formBody(call: Parameters<typeof fetch>): URLSearchParams {
  return new URLSearchParams(String(call[1]?.body));
}

/** Starts a login and returns the authorize URL the browser would be sent to. */
async function startLogin(auth: Auth, provider: "Google" | "email", redirect?: string) {
  await auth.login({ provider, redirect });
  return new URL(navigate.mock.calls.at(-1)![0]);
}

async function signIn(auth: Auth, redirect?: string) {
  const authorize = await startLogin(auth, "Google", redirect);
  fetchMock.mockResolvedValueOnce(tokenResponse({ refresh_token: "refresh-1" }));
  const state = authorize.searchParams.get("state");
  return auth.completeLogin(`${testConfig.origin}/auth/callback?code=the-code&state=${state}`);
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  persistent = new MemorySessionDb();
  legacy = new MemoryStorage();
  navigate = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login request", () => {
  it("sends Google logins straight to Google, with PKCE and state", async () => {
    const url = await startLogin(openTab(), "Google", "/albums");
    expect(url.origin + url.pathname).toBe(`${domain}/oauth2/authorize`);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: clientId,
      redirect_uri: "http://localhost:5173/auth/callback",
      response_type: "code",
      scope: "openid email profile",
      code_challenge_method: "S256",
      identity_provider: "Google",
    });
    expect(params.code_challenge).toMatch(/^[\w-]{43}$/);
    expect(params.state).toMatch(/^[0-9a-f]{32}$/);
  });

  it("shows only Cognito's email + password form for email", async () => {
    const url = await startLogin(openTab(), "email");
    expect(url.searchParams.get("identity_provider")).toBe("COGNITO");
  });

  it("uses a new state and PKCE challenge every time", async () => {
    const auth = openTab();
    const a = await startLogin(auth, "email");
    const b = await startLogin(auth, "email");
    expect(a.searchParams.get("state")).not.toBe(b.searchParams.get("state"));
    expect(a.searchParams.get("code_challenge")).not.toBe(b.searchParams.get("code_challenge"));
  });
});

describe("callback", () => {
  it("exchanges the code with the PKCE verifier and returns the remembered page", async () => {
    const auth = openTab();
    expect(await signIn(auth, "/albums?x=1")).toBe("/albums?x=1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TOKEN_URL);
    expect(init?.method).toBe("POST");
    const body = formBody(fetchMock.mock.calls[0]!);
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: clientId,
      redirect_uri: "http://localhost:5173/auth/callback",
    });
    expect(body.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);
    expect(body.has("client_secret")).toBe(false);

    expect(await auth.getUser()).toEqual(testUser);
    expect(await auth.getAccessToken()).toBe("access-1");
  });

  it("falls back to the gallery for unsafe redirect targets", async () => {
    expect(await signIn(openTab(), "//evil.example/x")).toBe("/gallery");
  });

  it("rejects a callback whose state this tab never issued", async () => {
    await expect(
      openTab().completeLogin(`${testConfig.origin}/auth/callback?code=c&state=forged`),
    ).rejects.toThrow("No matching state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can't be replayed: the state is used up", async () => {
    const auth = openTab();
    const state = (await startLogin(auth, "email")).searchParams.get("state");
    const callback = `${testConfig.origin}/auth/callback?code=c&state=${state}`;
    fetchMock.mockResolvedValueOnce(tokenResponse({ refresh_token: "refresh-1" }));
    await auth.completeLogin(callback);
    await expect(auth.completeLogin(callback)).rejects.toThrow("No matching state");
  });

  it("surfaces Cognito errors such as a cancelled login", async () => {
    const auth = openTab();
    const state = (await startLogin(auth, "Google")).searchParams.get("state");
    await expect(
      auth.completeLogin(`${testConfig.origin}/auth/callback?error=access_denied&state=${state}`),
    ).rejects.toMatchObject({ error: "access_denied" });
  });
});

/** The one stored session value. */
const stored = () => [...persistent.items.values()][0]!;

describe("token storage (option A)", () => {
  it("persists only the refresh token", async () => {
    await signIn(openTab());
    const value = stored();
    expect(persistent.items.size).toBe(1);
    expect(JSON.parse(value)).toMatchObject({ refresh_token: "refresh-1" });
    expect(value).not.toContain("access-1");
    expect(value).not.toContain(idToken);
    expect(value).not.toContain(testUser.email!);
  });

  it("restores the session in a new tab or after a restart via the refresh token (FR-AUTH-4)", async () => {
    await signIn(openTab());

    const restarted = openTab();
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: "access-2" }));
    expect(await restarted.getUser()).toEqual(testUser);
    expect(await restarted.getAccessToken()).toBe("access-2");

    const body = formBody(fetchMock.mock.calls[1]!);
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: clientId,
    });
    // Cognito doesn't rotate refresh tokens: the original one is kept.
    expect(stored()).toContain("refresh-1");
  });

  it("moves a session stored in localStorage by an older version (9.5)", async () => {
    await signIn(openTab());
    const [key, value] = [...persistent.items][0]!;
    persistent.items.clear();
    legacy.setItem(`photo-app.session.${key}`, value);

    const restarted = openTab();
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: "access-2" }));
    expect(await restarted.getAccessToken()).toBe("access-2");
    expect(persistent.items.get(key)).toContain("refresh-1");
    expect(legacy.length).toBe(0);
  });

  it("is readable by the service worker as refresh token + sub (9.5)", async () => {
    expect(await readStoredSession(persistent)).toBeNull();
    await signIn(openTab());
    expect(await readStoredSession(persistent)).toEqual({
      sub: testUser.sub,
      refreshToken: "refresh-1",
    });
  });

  it("refreshes once for concurrent callers", async () => {
    await signIn(openTab());
    const restarted = openTab();
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: "access-2" }));
    const tokens = await Promise.all([restarted.getAccessToken(), restarted.getAccessToken()]);
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // login + one refresh
  });

  it("ends the session when Cognito rejects the refresh token", async () => {
    await signIn(openTab());
    const restarted = openTab();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect(await restarted.getUser()).toBeNull();
    expect(persistent.items.size).toBe(0);
  });

  it("keeps the session when the refresh fails for network reasons", async () => {
    await signIn(openTab());
    const restarted = openTab();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(restarted.getUser()).rejects.toThrow();
    expect(persistent.items.size).toBe(1);
  });

  it("knows the stored session's user offline, by sub only (9.3)", async () => {
    await signIn(openTab());
    const restarted = openTab();
    expect(await restarted.getStoredUser()).toEqual({
      sub: testUser.sub,
      email: undefined,
      name: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the login: no refresh needed
  });

  it("has no stored user without a session", async () => {
    expect(await openTab().getStoredUser()).toBeNull();
    const auth = openTab();
    await signIn(auth);
    await auth.clearSession();
    expect(await openTab().getStoredUser()).toBeNull();
  });

  it("forces a refresh when the API rejected a still-valid token (8.4)", async () => {
    const auth = openTab();
    await signIn(auth);
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: "access-2" }));
    expect(await auth.refreshAccessToken()).toBe("access-2");
    expect(formBody(fetchMock.mock.calls[1]!).get("grant_type")).toBe("refresh_token");
    expect(await auth.getAccessToken()).toBe("access-2");
  });

  it("clears the local session without contacting Cognito", async () => {
    const auth = openTab();
    await signIn(auth);
    await auth.clearSession();
    expect(await auth.getUser()).toBeNull();
    expect(persistent.items.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the login
    expect(navigate).toHaveBeenCalledTimes(1); // only the login redirect
  });

  it("has no session without a login", async () => {
    expect(await openTab().getUser()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  // 7.3: the media cookies are renewed whenever tokens arrive.
  it("tells listeners about new tokens after login and every refresh, until unsubscribed", async () => {
    const auth = openTab();
    const listener = vi.fn();
    const unsubscribe = auth.onTokens(listener);

    await signIn(auth);
    expect(listener).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: "access-2" }));
    await auth.refreshAccessToken();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: "access-3" }));
    await auth.refreshAccessToken();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("logout (FR-AUTH-5)", () => {
  it("revokes the refresh token, forgets the session and ends the Cognito session", async () => {
    const auth = openTab();
    await signIn(auth);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await auth.logout();

    const [url] = fetchMock.mock.calls[1]!;
    expect(url).toBe(REVOKE_URL);
    expect(Object.fromEntries(formBody(fetchMock.mock.calls[1]!))).toMatchObject({
      token: "refresh-1",
      token_type_hint: "refresh_token",
      client_id: clientId,
    });
    expect(persistent.items.size).toBe(0);
    expect(await auth.getUser()).toBeNull();
    const logout = new URL(navigate.mock.calls.at(-1)![0]);
    expect(logout.origin + logout.pathname).toBe(`${domain}/logout`);
    expect(Object.fromEntries(logout.searchParams)).toEqual({
      client_id: clientId,
      logout_uri: "http://localhost:5173/login",
    });
  });

  it("still signs out locally when revocation fails", async () => {
    const auth = openTab();
    await signIn(auth);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await auth.logout();

    expect(persistent.items.size).toBe(0);
    expect(navigate).toHaveBeenLastCalledWith(expect.stringContaining("/logout?"));
  });
});
