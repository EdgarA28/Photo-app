import type { ErrorCode } from "@photo-app/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./env";
import { requireUser } from "./lib/auth";
import { AppError } from "./lib/errors";
import { errorFields, log } from "./lib/log";

/** JSON bodies are tiny (names, IDs, emails); photo bytes never pass through the API (FR-UP-4). */
const MAX_BODY_BYTES = 64 * 1024;

const HTTP_EXCEPTION_CODES: Partial<Record<number, ErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
};

export interface AppOptions {
  /** Registers the authenticated routes (5.5+). They run after `requireUser`. */
  routes?: (app: Hono<AppEnv>) => void;
  /**
   * Routes anyone may call (public photo links, FR-SHR-8). Registered before `requireUser`, so
   * they answer before it runs; API Gateway must also leave them without the JWT authorizer.
   */
  publicRoutes?: (app: Hono<AppEnv>) => void;
}

/**
 * The whole API (§9) as one Hono app under `/api` (D-1: one Lambda + router). CloudFront forwards
 * `/api/*` unchanged, so routes keep the prefix.
 */
export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new AppError(
          413,
          "PAYLOAD_TOO_LARGE",
          `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        );
      },
    }),
  );

  // Unauthenticated: used by the post-deploy smoke test (5.5, §14).
  app.get("/health", (c) => c.json({ status: "ok" }));
  options.publicRoutes?.(app);

  // Everything else requires a user. Unknown routes also answer 401 to anonymous callers.
  app.use("*", requireUser);
  options.routes?.(app);

  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Route not found"), 404));
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err.code, err.message), err.status);
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      const code = HTTP_EXCEPTION_CODES[status] ?? "INTERNAL_ERROR";
      return c.json(errorBody(code, err.message || code), status);
    }
    log("ERROR", "Unhandled error", {
      ...errorFields(err),
      method: c.req.method,
      path: c.req.path,
      requestId: c.env?.lambdaContext?.awsRequestId,
    });
    return c.json(errorBody("INTERNAL_ERROR", "Internal server error"), 500);
  });

  return app;
}

function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}
