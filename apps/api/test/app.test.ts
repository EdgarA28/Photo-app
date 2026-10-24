/** App skeleton: auth (NFR-SEC-1), error envelope (§9), validation, 404-not-403 (NFR-SEC-2). */
import { handle } from "@hono/aws-lambda";
import { apiErrorSchema, createAlbumRequestSchema, idSchema } from "@photo-app/shared";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app";
import { orNotFound } from "../src/lib/errors";
import { validate } from "../src/lib/validation";

const USER = "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f";
const OTHER = "00000000-0000-4000-8000-000000000000";
const ALBUM = "01JABCDEFGHJKMNPQRSTVWXYZ0";

/** Probe routes that exercise the middleware the real routes (5.5+) will use. */
const app = createApp({
  routes: (r) => {
    r.get("/whoami", (c) => c.json({ userId: c.get("userId") }));
    r.post("/albums", validate("json", createAlbumRequestSchema), (c) =>
      c.json(c.req.valid("json")),
    );
    r.get("/albums/:albumId", validate("param", z.object({ albumId: idSchema })), (c) => {
      // Pretend only USER owns ALBUM: anyone else gets the same 404 as for a missing album.
      const { albumId } = c.req.valid("param");
      const album = c.get("userId") === USER && albumId === ALBUM ? { albumId } : null;
      return c.json(orNotFound(album, "Album not found"));
    });
    r.get("/boom", () => {
      throw new Error("secret internal detail");
    });
  },
});

/** The env the Lambda adapter passes: API Gateway HTTP API event with JWT authorizer claims. */
function envFor(claims: Record<string, unknown> | null) {
  return {
    event: { requestContext: { authorizer: claims ? { jwt: { claims, scopes: null } } : {} } },
  };
}

/** `claims: null` = anonymous request (no authorizer claims). */
async function call(
  path: string,
  init: RequestInit = {},
  claims: Record<string, unknown> | null = { sub: USER },
) {
  const res = await app.request(path, init, envFor(claims));
  return { status: res.status, body: (await res.json()) as unknown };
}

function expectError(body: unknown, code: string) {
  const parsed = apiErrorSchema.parse(body);
  expect(parsed.error.code).toBe(code);
  return parsed.error.message;
}

describe("health", () => {
  test("needs no auth", async () => {
    expect(await call("/api/health", {}, null)).toEqual({ status: 200, body: { status: "ok" } });
  });
});

describe("auth (NFR-SEC-1)", () => {
  test("user ID comes from the JWT sub claim", async () => {
    expect(await call("/api/whoami")).toEqual({ status: 200, body: { userId: USER } });
  });

  test.each([
    ["no authorizer claims", null],
    ["no sub", { email: "a@b.c" }],
    ["sub not a UUID", { sub: "../../etc" }],
    ["sub uppercase", { sub: USER.toUpperCase() }],
    ["sub not a string", { sub: 42 }],
  ])("401 with %s", async (_name, claims) => {
    const { status, body } = await call("/api/whoami", {}, claims);
    expect(status).toBe(401);
    expectError(body, "UNAUTHORIZED");
  });

  test("identity in query or headers is ignored", async () => {
    const res = await call(`/api/whoami?userId=${OTHER}`, { headers: { "x-user-id": OTHER } });
    expect(res.body).toEqual({ userId: USER });
  });

  test("unknown routes are 401 for anonymous callers, 404 for users", async () => {
    expect((await call("/api/nope", {}, null)).status).toBe(401);
    const { status, body } = await call("/api/nope");
    expect(status).toBe(404);
    expectError(body, "NOT_FOUND");
  });
});

describe("validation", () => {
  const post = (
    body: string,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) => call("/api/albums", { method: "POST", body, headers });

  test("valid body is parsed with the shared schema (trimmed)", async () => {
    expect(await post(JSON.stringify({ name: "  Holidays " }))).toEqual({
      status: 200,
      body: { name: "Holidays" },
    });
  });

  test("schema violations are VALIDATION_ERROR with the field path", async () => {
    const { status, body } = await post(JSON.stringify({ name: "" }));
    expect(status).toBe(400);
    expect(expectError(body, "VALIDATION_ERROR")).toMatch(/^name: /);
  });

  test("malformed JSON is VALIDATION_ERROR", async () => {
    const { status, body } = await post("{not json");
    expect(status).toBe(400);
    expectError(body, "VALIDATION_ERROR");
  });

  test("bodies over 64 KB are PAYLOAD_TOO_LARGE", async () => {
    const { status, body } = await post(JSON.stringify({ name: "x".repeat(70_000) }));
    expect(status).toBe(413);
    expectError(body, "PAYLOAD_TOO_LARGE");
  });

  test("invalid path params are VALIDATION_ERROR", async () => {
    const { status, body } = await call("/api/albums/not-an-id");
    expect(status).toBe(400);
    expectError(body, "VALIDATION_ERROR");
  });
});

describe("404, not 403 (NFR-SEC-2)", () => {
  test("owner sees the album", async () => {
    expect((await call(`/api/albums/${ALBUM}`)).status).toBe(200);
  });

  test("another user's album looks exactly like a missing one", async () => {
    const foreign = await call(`/api/albums/${ALBUM}`, {}, { sub: OTHER });
    const missing = await call("/api/albums/01JZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(foreign).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Album not found" } },
    });
    expect(missing).toEqual(foreign);
  });
});

describe("unexpected errors", () => {
  test("are logged and returned as a generic INTERNAL_ERROR", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await call("/api/boom");
    expect(status).toBe(500);
    expect(expectError(body, "INTERNAL_ERROR")).not.toContain("secret");
    // An object, not a JSON string: the Lambda JSON log format keeps its fields queryable.
    expect(spy.mock.calls[0]![0]).toMatchObject({
      message: "Unhandled error",
      errorMessage: "secret internal detail",
      path: "/api/boom",
    });
    spy.mockRestore();
  });
});

describe("Lambda adapter", () => {
  test("API Gateway HTTP API event → app → proxy result", async () => {
    const handler = handle(app);
    const result = await handler({
      version: "2.0",
      routeKey: "ANY /api/{proxy+}",
      rawPath: "/api/whoami",
      rawQueryString: "",
      headers: { host: "example.cloudfront.net" },
      isBase64Encoded: false,
      body: null,
      requestContext: {
        accountId: "123456789012",
        apiId: "api",
        authentication: null,
        authorizer: { jwt: { claims: { sub: USER }, scopes: null } },
        domainName: "example.cloudfront.net",
        domainPrefix: "example",
        http: {
          method: "GET",
          path: "/api/whoami",
          protocol: "HTTP/1.1",
          sourceIp: "1.2.3.4",
          userAgent: "test",
        },
        requestId: "req-1",
        routeKey: "ANY /api/{proxy+}",
        stage: "$default",
        time: "19/Oct/2026:10:00:00 +0000",
        timeEpoch: 0,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ userId: USER });
  });
});
