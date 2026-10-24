import { z } from "zod";

// Public client configuration, baked in at build time from VITE_* variables: locally from
// .env.development.local (`pnpm env:dev`), in CI from the environment's tofu outputs (10.2).
const envSchema = z.object({
  VITE_COGNITO_USER_POOL_ID: z.string().regex(/^[a-z]{2}-[a-z]+-\d_[0-9A-Za-z]+$/),
  VITE_COGNITO_CLIENT_ID: z.string().min(1),
  VITE_COGNITO_DOMAIN: z.url({ protocol: /^https$/ }).transform((url) => url.replace(/\/$/, "")),
  VITE_GOOGLE_LOGIN: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export interface AppConfig {
  /** Origin the app runs on; callback and logout URLs are built from it (4.2 registers them). */
  origin: string;
  cognito: {
    /** Token issuer = the user pool (`iss` claim), also the oidc-client-ts authority. */
    issuer: string;
    clientId: string;
    /** Hosted (managed login) domain: authorize, token, revoke, logout endpoints. */
    domain: string;
  };
  /** Whether the app client allows Google (4.4); otherwise only email login is offered. */
  googleLogin: boolean;
}

export function loadConfig(
  env: Record<string, unknown> = import.meta.env,
  origin: string = window.location.origin,
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid app configuration (run \`pnpm env:dev\`?): ${z.prettifyError(parsed.error)}`,
    );
  }
  const vars = parsed.data;
  const region = vars.VITE_COGNITO_USER_POOL_ID.split("_")[0]!;
  return {
    origin,
    cognito: {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${vars.VITE_COGNITO_USER_POOL_ID}`,
      clientId: vars.VITE_COGNITO_CLIENT_ID,
      domain: vars.VITE_COGNITO_DOMAIN,
    },
    googleLogin: vars.VITE_GOOGLE_LOGIN,
  };
}
