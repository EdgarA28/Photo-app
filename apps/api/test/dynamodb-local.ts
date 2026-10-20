/**
 * Vitest global setup: provides a DynamoDB endpoint to the repository tests.
 *
 * - DYNAMODB_ENDPOINT set (e.g. a CI service container): use it as is.
 * - Otherwise start AWS's DynamoDB Local in Docker on a random port and remove it afterwards.
 */
import { execFileSync } from "node:child_process";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import type { TestProject } from "vitest/node";

const IMAGE = "amazon/dynamodb-local:3.3.1";

declare module "vitest" {
  export interface ProvidedContext {
    dynamodbEndpoint: string;
  }
}

export default async function setup(project: TestProject) {
  const existing = process.env.DYNAMODB_ENDPOINT;
  if (existing) {
    project.provide("dynamodbEndpoint", existing);
    return;
  }

  let containerId: string;
  try {
    containerId = docker(
      "run",
      "-d",
      "--rm",
      "-p",
      "127.0.0.1::8000",
      IMAGE,
      "-jar",
      "DynamoDBLocal.jar",
      "-inMemory",
    );
  } catch (err) {
    throw new Error(
      "apps/api tests need DynamoDB Local: start Docker, or set DYNAMODB_ENDPOINT to a running instance.",
      { cause: err },
    );
  }
  const port = docker("port", containerId, "8000/tcp").split("\n")[0]!.split(":").pop();
  const endpoint = `http://127.0.0.1:${port}`;
  await waitUntilReady(endpoint);
  project.provide("dynamodbEndpoint", endpoint);

  return () => {
    docker("rm", "-f", containerId);
  };
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function waitUntilReady(endpoint: string): Promise<void> {
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await client.send(new ListTablesCommand({}));
      client.destroy();
      return;
    } catch (err) {
      if (Date.now() > deadline)
        throw new Error("DynamoDB Local did not start in 30 s", { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
