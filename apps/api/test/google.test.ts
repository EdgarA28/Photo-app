/**
 * Google OAuth + Picker client (13.5c, §11.5, NFR-SEC-10) against a fake `fetch`, and the
 * optional import config. Nothing here calls Google.
 */
import { GOOGLE_PHOTOS_PICKER_SCOPE } from "@photo-app/shared";
import { describe, expect, test, vi } from "vitest";
import { loadImportConfig } from "../src/lib/config";
import {
  GOOGLE_TOKEN_URL,
  GoogleApiError,
  googlePhotosClient,
  parseDuration,
  PICKER_API_URL,
  toSession,
} from "../src/lib/google";

const SESSION = {
  id: "sess-1",
  pickerUri: "https://photos.google.com/picker/sess-1",
  pollingConfig: { pollInterval: "5s", timeoutIn: "1799s" },
  expireTime: "2026-11-21T20:30:00.123456789Z",
  mediaItemsSet: false,
};

function setup(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const res of responses) fetch.mockResolvedValueOnce(res);
  const loadClientSecret = vi.fn(async () => "secret-value");
  const client = googlePhotosClient({ clientId: "client-id", loadClientSecret, fetch });
  const request = (n = 0) => {
    const [url, init] = fetch.mock.calls[n]!;
    return { url: String(url), init: init! };
  };
  return { client, fetch, request, loadClientSecret };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const exchange = { code: "4/abc", codeVerifier: "v".repeat(43), redirectUri: "https://a/cb" };

describe("exchangeCode", () => {
  test("posts the code with PKCE verifier and client secret, returns the token", async () => {
    const { client, request } = setup(
      json({ access_token: "ya29.x", expires_in: 3599, scope: GOOGLE_PHOTOS_PICKER_SCOPE }),
    );
    const before = Date.now();
    const token = await client.exchangeCode(exchange);
    expect(token?.accessToken).toBe("ya29.x");
    expect(token!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);

    const { url, init } = request();
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      code: "4/abc",
      code_verifier: "v".repeat(43),
      redirect_uri: "https://a/cb",
      client_id: "client-id",
      client_secret: "secret-value",
    });
  });

  test.each([400, 401])("Google's %i (bad code, verifier or redirect) → null", async (status) => {
    const { client } = setup(json({ error: "invalid_grant" }, status));
    expect(await client.exchangeCode(exchange)).toBeNull();
  });

  test("null when the user unticked the Photos permission", async () => {
    const { client } = setup(json({ access_token: "ya29.x", expires_in: 3599, scope: "openid" }));
    expect(await client.exchangeCode(exchange)).toBeNull();
  });

  test("a server error throws without the code or the secret in the message", async () => {
    const { client } = setup(json({ error: "backend_error" }, 503));
    const err = await client.exchangeCode(exchange).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).message).toBe("Google token exchange failed: 503 backend_error");
    expect((err as Error).message).not.toMatch(/4\/abc|secret-value/);
  });

  test("a network error or timeout throws a GoogleApiError with status 0", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new DOMException("t", "TimeoutError"));
    const client = googlePhotosClient({ clientId: "c", loadClientSecret: async () => "s", fetch });
    const err = await client.exchangeCode(exchange).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "GoogleApiError", status: 0, googleCode: "TimeoutError" });
  });
});

describe("Picker sessions", () => {
  test("createSession sends the item limit with the token and reads the session", async () => {
    const { client, request } = setup(json(SESSION));
    const session = await client.createSession("ya29.x", 500);
    expect(session).toEqual({
      sessionId: "sess-1",
      pickerUri: SESSION.pickerUri,
      pollIntervalSec: 5,
      expiresAt: new Date("2026-11-21T20:30:00.123Z"),
      mediaItemsSet: false,
    });
    const { url, init } = request();
    expect(url).toBe(`${PICKER_API_URL}/sessions`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer ya29.x" });
    expect(JSON.parse(init.body as string)).toEqual({ pickingConfig: { maxItemCount: "500" } });
  });

  test("getSession: the session, null when Google forgot it, an error otherwise", async () => {
    const { client, request } = setup(
      json({ ...SESSION, mediaItemsSet: true }),
      json({ error: { code: 404, status: "NOT_FOUND" } }, 404),
      json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401),
    );
    expect((await client.getSession("t", "sess/1"))?.mediaItemsSet).toBe(true);
    expect(request().url).toBe(`${PICKER_API_URL}/sessions/sess%2F1`);
    expect(await client.getSession("t", "sess-1")).toBeNull();
    const err = await client.getSession("t", "sess-1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, googleCode: "UNAUTHENTICATED", unauthorized: true });
  });

  test("deleteSession accepts a session that is already gone", async () => {
    const { client, request } = setup(
      new Response(null, { status: 200 }),
      json({}, 404),
      json({}, 500),
    );
    await client.deleteSession("t", "sess-1");
    expect(request().init.method).toBe("DELETE");
    await client.deleteSession("t", "sess-1");
    await expect(client.deleteSession("t", "sess-1")).rejects.toBeInstanceOf(GoogleApiError);
  });

  test.each([
    ["no id", { ...SESSION, id: undefined }],
    ["an http picker URI", { ...SESSION, pickerUri: "http://photos.google.com/x" }],
    ["no expiry", { ...SESSION, expireTime: undefined }],
    ["a bad expiry", { ...SESSION, expireTime: "soon" }],
  ])("rejects a session with %s", (_, raw) => {
    expect(() => toSession(raw, "get session")).toThrow(GoogleApiError);
  });

  test.each([
    ["5s", 5],
    ["2.5s", 3],
    ["0.2s", 1],
    ["5", 5],
    [undefined, 5],
  ])("poll interval %s → %i s", (value, seconds) => {
    expect(parseDuration(value)).toBe(seconds);
  });
});

describe("loadImportConfig (13.5c)", () => {
  const env = {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET_PARAMETER: "/photo-app/dev/google-client-secret",
    IMPORT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/photo-app-dev-imports",
    IMPORT_REDIRECT_ORIGINS: "https://d.cloudfront.net, http://localhost:5173",
  };

  test("is off without a Google client ID", () => {
    expect(loadImportConfig({})).toBeNull();
  });

  test("reads the settings and the allowed origins", () => {
    expect(loadImportConfig(env)).toEqual({
      googleClientId: "client-id",
      googleClientSecretParameter: "/photo-app/dev/google-client-secret",
      importQueueUrl: env.IMPORT_QUEUE_URL,
      redirectOrigins: ["https://d.cloudfront.net", "http://localhost:5173"],
    });
  });

  test.each([
    ["a missing queue", { IMPORT_QUEUE_URL: "" }],
    ["a missing secret parameter", { GOOGLE_CLIENT_SECRET_PARAMETER: "" }],
    ["an origin with a path", { IMPORT_REDIRECT_ORIGINS: "https://a.example/app" }],
    ["no origins", { IMPORT_REDIRECT_ORIGINS: " , " }],
  ])("fails the cold start on %s", (_, change) => {
    expect(() => loadImportConfig({ ...env, ...change })).toThrow();
  });
});
