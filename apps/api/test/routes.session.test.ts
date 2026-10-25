/** Media cookies (7.3, §9, FR-AUTH-5): POST/DELETE /session/media-cookie and the key loader. */
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "@hono/aws-lambda";
import {
  MEDIA_COOKIE_TTL_SECONDS,
  SHARED_IMAGE_URL_TTL_SECONDS,
  apiErrorSchema,
  mediaCookieResponseSchema,
} from "@photo-app/shared";
import { createVerify } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app";
import { cloudFrontMediaSigner, ssmPrivateKeyLoader, type MediaSigner } from "../src/lib/media";
import type { Deps } from "../src/routes";
import { sessionRoutes } from "../src/routes/session";
import { TEST_MEDIA, newUserId, testMediaSigner, verifySignedUrl } from "./helpers";

const NAMES = [
  "CloudFront-Policy",
  "CloudFront-Signature",
  "CloudFront-Key-Pair-Id",
  "CloudFront-Hash-Algorithm",
];

// The session routes only use the signer.
const appWith = (media: MediaSigner) =>
  createApp({ routes: (app) => sessionRoutes(app, { media } as Deps) });

const asUser = (sub: string | null) => ({
  event: {
    requestContext: { authorizer: sub ? { jwt: { claims: { sub }, scopes: null } } : {} },
  },
});

/** Parses Set-Cookie headers into name → { value, attributes }. */
function parseSetCookies(res: Response) {
  return Object.fromEntries(
    res.headers.getSetCookie().map((header) => {
      const [pair, ...attributes] = header.split("; ");
      const [name, value] = pair!.split(/=(.*)/s);
      return [name!, { value: value!, attributes }];
    }),
  );
}

// CloudFront's URL-safe base64: + → -, = → _, / → ~.
const cfDecode = (value: string) =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");

describe("POST /session/media-cookie", () => {
  test("sets the signed cookies for the caller's prefix only, HttpOnly, 8 h", async () => {
    const sub = newUserId();
    const before = Date.now();
    const res = await appWith(testMediaSigner()).request(
      "/api/session/media-cookie",
      { method: "POST" },
      asUser(sub),
    );

    expect(res.status).toBe(200);
    const { expiresAt } = mediaCookieResponseSchema.parse(await res.json());
    const expiresMs = Date.parse(expiresAt);
    // Whole seconds, so up to 1 s less than the TTL from `before`.
    expect(expiresMs % 1000).toBe(0);
    expect(expiresMs - before).toBeGreaterThan((MEDIA_COOKIE_TTL_SECONDS - 1) * 1000);
    expect(expiresMs - Date.now()).toBeLessThanOrEqual(MEDIA_COOKIE_TTL_SECONDS * 1000);

    const cookies = parseSetCookies(res);
    expect(Object.keys(cookies).sort()).toEqual([...NAMES].sort());
    for (const { attributes } of Object.values(cookies)) {
      expect(attributes.sort()).toEqual(
        [
          `Max-Age=${MEDIA_COOKIE_TTL_SECONDS}`,
          `Path=/users/${sub}/`,
          "HttpOnly",
          "Secure",
          "SameSite=Lax",
        ].sort(),
      );
    }
  });

  test("the policy covers /users/{sub}/* until expiresAt and verifies with the public key", async () => {
    const sub = newUserId();
    const res = await appWith(testMediaSigner()).request(
      "/api/session/media-cookie",
      { method: "POST" },
      asUser(sub),
    );
    const { expiresAt } = mediaCookieResponseSchema.parse(await res.json());
    const cookies = parseSetCookies(res);

    const policy = cfDecode(cookies["CloudFront-Policy"]!.value).toString("utf8");
    expect(JSON.parse(policy)).toEqual({
      Statement: [
        {
          Resource: `${TEST_MEDIA.origin}/users/${sub}/*`,
          Condition: { DateLessThan: { "AWS:EpochTime": Date.parse(expiresAt) / 1000 } },
        },
      ],
    });
    expect(cookies["CloudFront-Key-Pair-Id"]!.value).toBe(TEST_MEDIA.keyPairId);
    expect(cookies["CloudFront-Hash-Algorithm"]!.value).toBe("SHA256");

    const signature = cfDecode(cookies["CloudFront-Signature"]!.value);
    expect(createVerify("RSA-SHA256").update(policy).verify(TEST_MEDIA.publicKey, signature)).toBe(
      true,
    );
  });

  test("anonymous callers get 401 and no cookies", async () => {
    const res = await appWith(testMediaSigner()).request(
      "/api/session/media-cookie",
      { method: "POST" },
      asUser(null),
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("a signing failure (e.g. SSM unavailable) is a 500 without cookies", async () => {
    const media = cloudFrontMediaSigner({
      origin: TEST_MEDIA.origin,
      keyPairId: TEST_MEDIA.keyPairId,
      loadPrivateKey: () => Promise.reject(new Error("SSM down")),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await appWith(media).request(
      "/api/session/media-cookie",
      { method: "POST" },
      asUser(newUserId()),
    );
    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("INTERNAL_ERROR");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("the Lambda response carries every cookie (API Gateway v2 `cookies` list)", async () => {
    const sub = newUserId();
    const handler = handle(appWith(testMediaSigner()));
    const result = (await handler({
      version: "2.0",
      routeKey: "ANY /api/{proxy+}",
      rawPath: "/api/session/media-cookie",
      rawQueryString: "",
      headers: { host: "api.test.example" },
      isBase64Encoded: false,
      requestContext: {
        http: { method: "POST", path: "/api/session/media-cookie", sourceIp: "203.0.113.1" },
        authorizer: { jwt: { claims: { sub }, scopes: null } },
      },
    } as never)) as { statusCode: number; cookies?: string[] };

    expect(result.statusCode).toBe(200);
    expect(result.cookies?.map((cookie) => cookie.split("=")[0]).sort()).toEqual([...NAMES].sort());
  });
});

describe("DELETE /session/media-cookie", () => {
  test("expires every cookie on the same path; idempotent", async () => {
    const sub = newUserId();
    const app = appWith(testMediaSigner());
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/session/media-cookie", { method: "DELETE" }, asUser(sub));
      expect(res.status).toBe(204);
      const cookies = parseSetCookies(res);
      expect(Object.keys(cookies).sort()).toEqual([...NAMES].sort());
      for (const { value, attributes } of Object.values(cookies)) {
        expect(value).toBe("");
        expect(attributes).toContain("Max-Age=0");
        expect(attributes).toContain(`Path=/users/${sub}/`);
      }
    }
  });

  test("anonymous callers get 401", async () => {
    const res = await appWith(testMediaSigner()).request(
      "/api/session/media-cookie",
      { method: "DELETE" },
      asUser(null),
    );
    expect(res.status).toBe(401);
  });
});

describe("signUrl (7.4)", () => {
  test("a relative URL signed for exactly that file, valid 15 min", async () => {
    const path = `/users/${newUserId()}/previews/01JB2Z3M4N5P6Q7R8S9T000001.jpg`;
    const now = new Date("2026-10-25T12:00:00.400Z");
    const url = await testMediaSigner().signUrl(path, now);
    // Whole seconds from `now`, like the cookies.
    expect(verifySignedUrl(url, path)).toBe(
      Math.floor(now.getTime() / 1000) + SHARED_IMAGE_URL_TTL_SECONDS,
    );
  });
});

describe("ssmPrivateKeyLoader", () => {
  const NAME = "/photo-app/test/cloudfront/media-private-key";

  test("reads the decrypted parameter once and reuses it", async () => {
    const send = vi.fn(async (_command: unknown) => ({ Parameter: { Value: "PEM" } }));
    const load = ssmPrivateKeyLoader({ send } as unknown as SSMClient, NAME);

    expect(await Promise.all([load(), load()])).toEqual(["PEM", "PEM"]);
    expect(await load()).toBe("PEM");
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as GetParameterCommand;
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect(command.input).toEqual({ Name: NAME, WithDecryption: true });
  });

  test("a failed read is retried on the next call", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValueOnce({ Parameter: { Value: "PEM" } });
    const load = ssmPrivateKeyLoader({ send } as unknown as SSMClient, NAME);

    await expect(load()).rejects.toThrow("throttled");
    expect(await load()).toBe("PEM");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("an empty parameter is an error", async () => {
    const send = vi.fn(async () => ({ Parameter: {} }));
    const load = ssmPrivateKeyLoader({ send } as unknown as SSMClient, NAME);
    await expect(load()).rejects.toThrow("no value");
  });
});
