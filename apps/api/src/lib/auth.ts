import { isUserId } from "@photo-app/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { AppError } from "./errors";

/**
 * NFR-SEC-1: the caller's user ID comes only from the JWT `sub` claim that the API Gateway JWT
 * authorizer has already validated (signature, issuer, expiry, client). Paths, query strings and
 * bodies never carry the caller's identity.
 *
 * The token itself is not re-verified here: the Lambda is reachable only through API Gateway
 * (its resource policy is scoped to the API in 5.4), and the authorizer rejects requests first.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const sub = jwtClaims(c.env?.event)?.sub;
  if (typeof sub !== "string" || !isUserId(sub)) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  c.set("userId", sub);
  await next();
});

function jwtClaims(event: unknown): Record<string, unknown> | undefined {
  // HTTP API (payload v2): event.requestContext.authorizer.jwt.claims
  if (typeof event !== "object" || event === null) return undefined;
  const requestContext = (event as { requestContext?: unknown }).requestContext;
  if (typeof requestContext !== "object" || requestContext === null) return undefined;
  const authorizer = (requestContext as { authorizer?: unknown }).authorizer;
  if (typeof authorizer !== "object" || authorizer === null) return undefined;
  const jwt = (authorizer as { jwt?: unknown }).jwt;
  if (typeof jwt !== "object" || jwt === null) return undefined;
  const claims = (jwt as { claims?: unknown }).claims;
  return typeof claims === "object" && claims !== null
    ? (claims as Record<string, unknown>)
    : undefined;
}
