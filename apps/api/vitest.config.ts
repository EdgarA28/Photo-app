import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    // Starts DynamoDB Local in Docker for the repository tests (or uses DYNAMODB_ENDPOINT).
    globalSetup: ["./test/dynamodb-local.ts"],
  },
});
