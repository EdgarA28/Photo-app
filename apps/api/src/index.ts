/** Lambda entry point (`index.handler` in dist/index.mjs), invoked by the API Gateway HTTP API. */
import { handle } from "@hono/aws-lambda";
import { createApp } from "./app";

// Built once per execution environment and reused across warm invocations.
export const handler = handle(createApp());
