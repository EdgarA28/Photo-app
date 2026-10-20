/** Config loading and the Cognito user directory (5.5). */
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/lib/config";
import { cognitoUserDirectory } from "../src/lib/users";

const USER = "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f";

describe("loadConfig", () => {
  const env = { TABLE_NAME: "t", USER_POOL_ID: "us-east-1_abc", DEFAULT_QUOTA_BYTES: "2147483648" };

  test("reads all settings", () => {
    expect(loadConfig(env)).toEqual({
      tableName: "t",
      userPoolId: "us-east-1_abc",
      defaultQuotaBytes: 2147483648,
    });
  });

  test.each(["TABLE_NAME", "USER_POOL_ID", "DEFAULT_QUOTA_BYTES"])("requires %s", (name) => {
    expect(() => loadConfig({ ...env, [name]: "" })).toThrow(name);
  });

  test.each(["0", "-1", "1.5", "10GB"])("rejects quota %s", (value) => {
    expect(() => loadConfig({ ...env, DEFAULT_QUOTA_BYTES: value })).toThrow("positive integer");
  });
});

describe("cognitoUserDirectory", () => {
  function directory(users: { Attributes: { Name: string; Value: string }[] }[]) {
    const send = vi.fn(async (_command: unknown) => ({ Users: users }));
    const client = { send } as unknown as CognitoIdentityProviderClient;
    return { send, users: cognitoUserDirectory(client, "us-east-1_pool") };
  }

  test("looks the user up by sub and maps email and name", async () => {
    const { send, users } = directory([
      {
        Attributes: [
          { Name: "sub", Value: USER },
          { Name: "email", Value: "ada@example.com" },
          { Name: "name", Value: "Ada" },
        ],
      },
    ]);
    expect(await users.getProfile(USER)).toEqual({ email: "ada@example.com", name: "Ada" });
    expect(send.mock.calls[0]![0]).toMatchObject({
      input: { UserPoolId: "us-east-1_pool", Filter: `sub = "${USER}"`, Limit: 1 },
    });
  });

  test("name is optional; no user or no email means no profile", async () => {
    expect(
      await directory([{ Attributes: [{ Name: "email", Value: "a@b.co" }] }]).users.getProfile(
        USER,
      ),
    ).toEqual({ email: "a@b.co", name: null });
    expect(await directory([]).users.getProfile(USER)).toBeNull();
    expect(
      await directory([{ Attributes: [{ Name: "name", Value: "x" }] }]).users.getProfile(USER),
    ).toBeNull();
  });

  test("never builds a filter from a malformed sub", async () => {
    const { send, users } = directory([]);
    expect(await users.getProfile('x" or email ^= "')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
