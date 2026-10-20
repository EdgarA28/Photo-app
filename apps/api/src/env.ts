import type { LambdaContext, LambdaEvent } from "@hono/aws-lambda";

/** Hono environment: the raw Lambda event/context (from the adapter) and per-request variables. */
export interface AppEnv {
  Bindings: {
    event: LambdaEvent;
    lambdaContext?: LambdaContext;
  };
  Variables: {
    /** Cognito `sub` of the caller. The only source of user identity (NFR-SEC-1). */
    userId: string;
  };
}
