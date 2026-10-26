import { describe, expect, it, vi } from "vitest";
import { createWorkerAuth } from "../src/pwa/workerAuth";
import { testConfig } from "./fakes";

const SESSION = { sub: "user-1", refreshToken: "refresh-1" };
const tokens = (access_token: string, expires_in = 3600) =>
  Response.json({ access_token, id_token: "id", token_type: "Bearer", expires_in });

function setup() {
  let clock = 1_000_000;
  const fetch = vi.fn<typeof globalThis.fetch>();
  const auth = createWorkerAuth(testConfig, SESSION, { fetch, now: () => clock });
  return { auth, fetch, advance: (ms: number) => (clock += ms) };
}

describe("service worker tokens (9.5)", () => {
  it("exchanges the stored refresh token at Cognito, once for concurrent callers", async () => {
    const { auth, fetch } = setup();
    fetch.mockResolvedValueOnce(tokens("access-1"));
    expect(await Promise.all([auth.getAccessToken(), auth.getAccessToken()])).toEqual([
      "access-1",
      "access-1",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${testConfig.cognito.domain}/oauth2/token`);
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "refresh_token",
      client_id: testConfig.cognito.clientId,
      refresh_token: "refresh-1",
    });
  });

  it("reuses the access token until shortly before it expires", async () => {
    const { auth, fetch, advance } = setup();
    fetch.mockResolvedValueOnce(tokens("access-1")).mockResolvedValueOnce(tokens("access-2"));
    await auth.getAccessToken();
    advance(58 * 60 * 1000);
    expect(await auth.getAccessToken()).toBe("access-1");
    advance(2 * 60 * 1000);
    expect(await auth.getAccessToken()).toBe("access-2");
  });

  it("refreshes on demand (the API rejected the token)", async () => {
    const { auth, fetch } = setup();
    fetch.mockResolvedValueOnce(tokens("access-1")).mockResolvedValueOnce(tokens("access-2"));
    await auth.getAccessToken();
    expect(await auth.refreshAccessToken()).toBe("access-2");
  });

  it("ends when Cognito rejects the refresh token, without asking again", async () => {
    const { auth, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect(await auth.getAccessToken()).toBeNull();
    expect(auth.ended).toBe(true);
    expect(await auth.getAccessToken()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails retryably without a connection or on Cognito errors", async () => {
    const { auth, fetch } = setup();
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(auth.getAccessToken()).rejects.toMatchObject({ retryable: true });
    fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(auth.getAccessToken()).rejects.toMatchObject({ retryable: true });
    expect(auth.ended).toBe(false);
  });
});
