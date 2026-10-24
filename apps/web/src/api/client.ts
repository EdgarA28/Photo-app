import { apiErrorSchema } from "@photo-app/shared";
import type { z } from "zod";
import type { Auth } from "@/auth/auth";
import { ApiRequestError } from "./errors";

/** Same origin: CloudFront `/api/*` in production, the Vite proxy locally (no CORS, §9). */
const BASE = "/api";

export interface RequestOptions<T> {
  /** Response body schema; omit for 204 routes. */
  schema?: z.ZodType<T>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

export type Request = <T = void>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options?: RequestOptions<T>,
) => Promise<T>;

export interface ClientDeps {
  auth: Pick<Auth, "getAccessToken" | "refreshAccessToken">;
  /** The session is over (no token, or rejected twice): the app sends the user to /login. */
  onUnauthorized: () => void;
  fetch?: typeof fetch;
}

/**
 * Bearer-token JSON client (8.4). Every response is parsed with the shared Zod schemas, so a
 * contract mismatch fails loudly here instead of somewhere in the UI. A 401 refreshes the token
 * once and retries (the access token can be rejected before its local expiry, e.g. clock skew).
 */
export function createRequest({
  auth,
  onUnauthorized,
  fetch: doFetch = fetch,
}: ClientDeps): Request {
  function unauthorized(): never {
    onUnauthorized();
    throw new ApiRequestError("UNAUTHORIZED", "Not signed in", 401);
  }

  async function send(
    method: string,
    url: string,
    token: string,
    options: RequestOptions<unknown>,
  ) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    try {
      return await doFetch(url, { method, headers, body, signal: options.signal ?? null });
    } catch (error) {
      if (options.signal?.aborted) throw error; // cancelled by Query, not a failure
      throw new ApiRequestError("NETWORK_ERROR", "Network request failed", 0);
    }
  }

  return async function request<T>(
    method: string,
    path: string,
    options: RequestOptions<T> = {},
  ): Promise<T> {
    const url = BASE + path + queryString(options.query);

    const token = await auth.getAccessToken();
    if (!token) unauthorized();
    let response = await send(method, url, token, options);
    if (response.status === 401) {
      const fresh = await auth.refreshAccessToken();
      if (!fresh) unauthorized();
      response = await send(method, url, fresh, options);
      if (response.status === 401) unauthorized();
    }

    if (!response.ok) throw await toError(response);
    if (!options.schema) return undefined as T;
    const parsed = options.schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ApiRequestError(
        "INVALID_RESPONSE",
        `Unexpected response from ${method} ${path}`,
        response.status,
      );
    }
    return parsed.data;
  };
}

function queryString(query: RequestOptions<unknown>["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Our API sends `{error: {code, message}}`; API Gateway itself (401/403/429/5xx) sends `{message}`. */
async function toError(response: Response): Promise<ApiRequestError> {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => undefined));
  if (parsed.success) {
    return new ApiRequestError(parsed.data.error.code, parsed.data.error.message, response.status);
  }
  const code =
    response.status === 401 || response.status === 403
      ? "UNAUTHORIZED"
      : response.status === 429
        ? "RATE_LIMITED"
        : "INTERNAL_ERROR";
  return new ApiRequestError(code, `HTTP ${response.status}`, response.status);
}
