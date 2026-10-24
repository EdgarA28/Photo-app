import { meResponseSchema } from "@photo-app/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "../src/api/client";
import { ApiRequestError } from "../src/api/errors";
import { testMe } from "./fakes";

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let onUnauthorized: ReturnType<typeof vi.fn<() => void>>;
let auth: {
  getAccessToken: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  refreshAccessToken: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
};

function client() {
  return createRequest({ auth, onUnauthorized, fetch: fetchMock });
}

const apiError = (status: number, code: string, message = code) =>
  Response.json({ error: { code, message } }, { status });

function authHeader(call: number) {
  return (fetchMock.mock.calls[call]![1]!.headers as Record<string, string>).Authorization;
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  onUnauthorized = vi.fn();
  auth = {
    getAccessToken: vi.fn(async () => "token-1"),
    refreshAccessToken: vi.fn(async () => "token-2"),
  };
});

describe("request", () => {
  it("calls the same-origin /api path with the bearer token and parses the body", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(testMe));
    const me = await client()("GET", "/me", { schema: meResponseSchema });
    expect(me).toEqual(testMe);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/me");
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer token-1" } });
    expect(init?.body).toBeUndefined();
  });

  it("sends JSON bodies and query strings (skipping undefined values)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client()("POST", "/albums/A/photos", {
      body: { photoIds: ["P"] },
      query: { sort: "taken-asc", cursor: undefined, limit: 50 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/albums/A/photos?sort=taken-asc&limit=50");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init?.body).toBe('{"photoIds":["P"]}');
  });

  it("returns undefined for 204 routes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client()("DELETE", "/photos/P")).resolves.toBeUndefined();
  });

  it("rejects responses that don't match the contract", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...testMe, usage: null }));
    await expect(client()("GET", "/me", { schema: meResponseSchema })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });
});

describe("errors", () => {
  it("passes on the API's error code and message", async () => {
    fetchMock.mockResolvedValueOnce(apiError(413, "QUOTA_EXCEEDED", "Storage quota exceeded"));
    const error = await client()("POST", "/photos/upload-url", { body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", status: 413, retryable: false });
    expect(error.message).toBe("Storage quota exceeded");
  });

  it.each([
    [429, "RATE_LIMITED", true],
    [503, "INTERNAL_ERROR", true],
    [403, "UNAUTHORIZED", false],
  ])("maps API Gateway's own %i to %s", async (status, code, retryable) => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: "x" }, { status }));
    await expect(client()("GET", "/me")).rejects.toMatchObject({ code, status, retryable });
  });

  it("reports network failures as retryable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client()("GET", "/me")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });
  });

  it("lets aborts through unchanged (Query cancelled the request)", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(client()("GET", "/me", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("authentication", () => {
  it("refreshes once and retries after a 401", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ message: "Unauthorized" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json(testMe));
    await expect(client()("GET", "/me", { schema: meResponseSchema })).resolves.toEqual(testMe);
    expect(authHeader(0)).toBe("Bearer token-1");
    expect(authHeader(1)).toBe("Bearer token-2");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("gives up after a second 401", async () => {
    fetchMock.mockResolvedValue(Response.json({ message: "Unauthorized" }, { status: 401 }));
    await expect(client()("GET", "/me")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("gives up when the refresh token is no longer valid", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: "Unauthorized" }, { status: 401 }));
    auth.refreshAccessToken.mockResolvedValueOnce(null);
    await expect(client()("GET", "/me")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("doesn't call the API without a session", async () => {
    auth.getAccessToken.mockResolvedValueOnce(null);
    await expect(client()("GET", "/me")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
