/** Config loading, the Cognito user directory (5.5) and the photo bucket (5.6). */
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { S3Client } from "@aws-sdk/client-s3";
import { UPLOAD_URL_TTL_SECONDS } from "@photo-app/shared";
import { describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/lib/config";
import { s3PhotoStorage } from "../src/lib/storage";
import { cognitoUserDirectory } from "../src/lib/users";

const USER = "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f";

describe("loadConfig", () => {
  const env = {
    TABLE_NAME: "t",
    PHOTO_BUCKET: "photos",
    USER_POOL_ID: "us-east-1_abc",
    DEFAULT_QUOTA_BYTES: "2147483648",
  };

  test("reads all settings", () => {
    expect(loadConfig(env)).toEqual({
      tableName: "t",
      photoBucket: "photos",
      userPoolId: "us-east-1_abc",
      defaultQuotaBytes: 2147483648,
    });
  });

  test.each(["TABLE_NAME", "PHOTO_BUCKET", "USER_POOL_ID", "DEFAULT_QUOTA_BYTES"])(
    "requires %s",
    (name) => {
      expect(() => loadConfig({ ...env, [name]: "" })).toThrow(name);
    },
  );

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

describe("s3PhotoStorage", () => {
  // Real signing with static credentials: createPresignedPost makes no network call.
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  });
  const storage = s3PhotoStorage(client, "photo-bucket");
  const key = `users/${USER}/originals/01JABCDEFGHJKMNPQRSTVWXYZ0.heic`;

  test("POST policy pins bucket, key, content type, storage class and exact size (NFR-SEC-6)", async () => {
    const before = Date.now();
    const post = await storage.createUploadPost({
      key,
      contentType: "image/heic",
      sizeBytes: 1234,
    });

    expect(post.url).toBe("https://photo-bucket.s3.us-east-1.amazonaws.com/");
    expect(post.fields).toMatchObject({
      key,
      "Content-Type": "image/heic",
      "x-amz-storage-class": "INTELLIGENT_TIERING",
    });
    const policy = JSON.parse(Buffer.from(post.fields.Policy!, "base64").toString("utf8")) as {
      expiration: string;
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket: "photo-bucket" },
        { key },
        ["eq", "$Content-Type", "image/heic"],
        ["eq", "$x-amz-storage-class", "INTELLIGENT_TIERING"],
        ["content-length-range", 1234, 1234],
      ]),
    );
    // 15 minutes (§9), allowing for the test's own runtime.
    const ttl = (Date.parse(policy.expiration) - before) / 1000;
    expect(ttl).toBeGreaterThan(UPLOAD_URL_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(UPLOAD_URL_TTL_SECONDS + 5);
  });
});
