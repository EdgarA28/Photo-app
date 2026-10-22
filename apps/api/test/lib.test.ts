/** Config loading, the Cognito user directory (5.5) and the photo bucket (5.6, 5.8, 5.9). */
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { DOWNLOAD_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS } from "@photo-app/shared";
import { describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/lib/config";
import { attachmentDisposition, s3PhotoStorage } from "../src/lib/storage";
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
  function directory(
    users: {
      Attributes: { Name: string; Value: string }[];
      UserStatus?: string;
      Enabled?: boolean;
    }[],
  ) {
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

  const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const user = (
    sub: string,
    extra: { verified?: string; UserStatus?: string; Enabled?: boolean } = {},
  ) => ({
    Attributes: [
      { Name: "sub", Value: sub },
      { Name: "email", Value: "ada@example.com" },
      ...(extra.verified === undefined ? [] : [{ Name: "email_verified", Value: extra.verified }]),
    ],
    ...(extra.UserStatus === undefined ? {} : { UserStatus: extra.UserStatus }),
    ...(extra.Enabled === undefined ? {} : { Enabled: extra.Enabled }),
  });

  test("findByEmail: returns the one confirmed, enabled user with the email verified", async () => {
    const { send, users } = directory([
      user(OTHER, { verified: "true", UserStatus: "UNCONFIRMED", Enabled: true }),
      user(OTHER, { verified: "true", UserStatus: "CONFIRMED", Enabled: false }),
      // Someone who set the address on their own account without verifying it.
      user(OTHER, { verified: "false", UserStatus: "CONFIRMED", Enabled: true }),
      user(OTHER, { UserStatus: "CONFIRMED", Enabled: true }),
      user(USER, { verified: "true", UserStatus: "EXTERNAL_PROVIDER", Enabled: true }),
    ]);
    expect(await users.findByEmail("ada@example.com")).toEqual({
      userId: USER,
      email: "ada@example.com",
    });
    expect(send.mock.calls[0]![0]).toMatchObject({
      input: { UserPoolId: "us-east-1_pool", Filter: 'email = "ada@example.com"' },
    });
  });

  test("findByEmail: two verified users with the same email → null, never a guess", async () => {
    const { users } = directory([
      user(USER, { verified: "true", UserStatus: "CONFIRMED" }),
      user(OTHER, { verified: "true", UserStatus: "EXTERNAL_PROVIDER" }),
    ]);
    expect(await users.findByEmail("ada@example.com")).toBeNull();
  });

  test("findByEmail: nobody, only unconfirmed users, or a filter-breaking value → null", async () => {
    expect(await directory([]).users.findByEmail("a@b.co")).toBeNull();
    expect(
      await directory([
        { Attributes: [{ Name: "sub", Value: USER }], UserStatus: "UNCONFIRMED" } as never,
      ]).users.findByEmail("a@b.co"),
    ).toBeNull();
    const { send, users } = directory([]);
    expect(await users.findByEmail('a" or email ^= "')).toBeNull();
    expect(await users.findByEmail("a\\@b.co")).toBeNull();
    expect(send).not.toHaveBeenCalled();
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

  test("download URL: pre-signed GET for the key, 5 min, attachment under the file name (FR-DL-1/2)", async () => {
    const url = new URL(await storage.createDownloadUrl({ key, fileName: "Beach day.heic" }));

    expect(url.origin + url.pathname).toBe(
      `https://photo-bucket.s3.us-east-1.amazonaws.com/${key}`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(DOWNLOAD_URL_TTL_SECONDS));
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="Beach day.heic"; filename*=UTF-8''Beach%20day.heic`,
    );
    // The disposition is covered by the signature, so it can't be changed by the holder.
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("deleteObjects: one quiet DeleteObjects call; per-key errors are thrown", async () => {
    const send = vi.spyOn(client, "send");
    send.mockResolvedValueOnce({} as never);
    await storage.deleteObjects([key, "other"]);
    const command = send.mock.calls[0]![0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({
      Bucket: "photo-bucket",
      Delete: { Objects: [{ Key: key }, { Key: "other" }], Quiet: true },
    });

    send.mockResolvedValueOnce({ Errors: [{ Key: key, Code: "AccessDenied" }] } as never);
    await expect(storage.deleteObjects([key])).rejects.toThrow(`${key} (AccessDenied)`);

    send.mockClear();
    await storage.deleteObjects([]);
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });
});

describe("attachmentDisposition (FR-DL-2)", () => {
  test.each([
    ["IMG_0001.JPG", `attachment; filename="IMG_0001.JPG"; filename*=UTF-8''IMG_0001.JPG`],
    // Non-ASCII: placeholder in the fallback, exact name in filename*.
    [
      "Café 🌅.jpg",
      `attachment; filename="Caf_ _.jpg"; filename*=UTF-8''Caf%C3%A9%20%F0%9F%8C%85.jpg`,
    ],
    // Quotes and backslashes can't break out of the quoted fallback.
    ['a"b\\c.png', `attachment; filename="a_b_c.png"; filename*=UTF-8''a%22b%5Cc.png`],
    // RFC 8187 attr-chars: ' ( ) * are encoded too.
    [
      "it's (1).webp",
      `attachment; filename="it's (1).webp"; filename*=UTF-8''it%27s%20%281%29.webp`,
    ],
    // An unpaired surrogate (valid JSON, invalid UTF-16) becomes U+FFFD instead of throwing.
    ["x\ud800.jpg", `attachment; filename="x_.jpg"; filename*=UTF-8''x%EF%BF%BD.jpg`],
  ])("%s", (name, expected) => {
    expect(attachmentDisposition(name)).toBe(expected);
  });
});
