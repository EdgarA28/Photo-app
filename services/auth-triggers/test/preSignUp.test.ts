/** Pre sign-up trigger: account linking (FR-AUTH-3, spec §11.3). */
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, test, vi } from "vitest";
import { cognitoPoolDirectory, type PoolDirectory, type PoolUser } from "../src/directory";
import {
  EMAIL_TAKEN_MESSAGE,
  createPreSignUpHandler,
  parseExternalUserName,
  type PreSignUpEvent,
} from "../src/preSignUp";

const POOL = "us-east-1_test";
const NATIVE = "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f";
const GOOGLE_ID = "109876543210987654321";

function event(overrides: Partial<PreSignUpEvent> = {}, attributes = {}): PreSignUpEvent {
  return {
    triggerSource: "PreSignUp_ExternalProvider",
    userPoolId: POOL,
    userName: `Google_${GOOGLE_ID}`,
    request: {
      userAttributes: { email: "edgar@example.com", email_verified: "true", ...attributes },
    },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
    ...overrides,
  };
}

function nativeUser(overrides: Partial<PoolUser> = {}): PoolUser {
  return {
    username: NATIVE,
    status: "CONFIRMED",
    enabled: true,
    emailVerified: true,
    ...overrides,
  };
}

function googleUser(overrides: Partial<PoolUser> = {}): PoolUser {
  return nativeUser({ username: `Google_${GOOGLE_ID}`, status: "EXTERNAL_PROVIDER", ...overrides });
}

function fakeDirectory(users: PoolUser[] = []) {
  const directory = {
    findByEmail: vi.fn<PoolDirectory["findByEmail"]>(async () => users),
    linkProvider: vi.fn<PoolDirectory["linkProvider"]>(async () => {}),
  };
  return { directory, handler: createPreSignUpHandler(directory) };
}

describe("Google sign-up (PreSignUp_ExternalProvider)", () => {
  test("links to the confirmed native user with the same verified email", async () => {
    const { directory, handler } = fakeDirectory([nativeUser()]);
    const input = event();

    const output = await handler(input);

    expect(directory.findByEmail).toHaveBeenCalledWith(POOL, "edgar@example.com");
    expect(directory.linkProvider).toHaveBeenCalledWith(POOL, NATIVE, "Google", GOOGLE_ID);
    // The event goes back unchanged: Cognito continues the sign-in.
    expect(output).toEqual(event());
  });

  test("searches with the normalised email", async () => {
    const { directory, handler } = fakeDirectory([nativeUser()]);

    await handler(event({}, { email: "  Edgar@Example.COM " }));

    expect(directory.findByEmail).toHaveBeenCalledWith(POOL, "edgar@example.com");
    expect(directory.linkProvider).toHaveBeenCalledOnce();
  });

  test("accepts the provider prefix in any case", async () => {
    const { directory, handler } = fakeDirectory([nativeUser()]);

    await handler(event({ userName: `google_${GOOGLE_ID}` }));

    expect(directory.linkProvider).toHaveBeenCalledWith(POOL, NATIVE, "Google", GOOGLE_ID);
  });

  test("does nothing for a new user", async () => {
    const { directory, handler } = fakeDirectory([]);

    await expect(handler(event())).resolves.toEqual(event());
    expect(directory.linkProvider).not.toHaveBeenCalled();
  });

  test.each([
    ["false", "false"],
    ["missing", undefined],
  ])("never links when Google's email_verified is %s", async (_, verified) => {
    const { directory, handler } = fakeDirectory([nativeUser()]);

    await handler(event({}, { email_verified: verified }));

    expect(directory.findByEmail).not.toHaveBeenCalled();
    expect(directory.linkProvider).not.toHaveBeenCalled();
  });

  test.each([
    ["unconfirmed", nativeUser({ status: "UNCONFIRMED" })],
    ["disabled", nativeUser({ enabled: false })],
    ["with an unverified email", nativeUser({ emailVerified: false })],
    ["federated", googleUser({ username: "Google_555" })],
  ])("ignores a matching user who is %s", async (_, user) => {
    const { directory, handler } = fakeDirectory([user]);

    await handler(event());

    expect(directory.linkProvider).not.toHaveBeenCalled();
  });

  test("never guesses between several native users", async () => {
    const { directory, handler } = fakeDirectory([
      nativeUser(),
      nativeUser({ username: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" }),
    ]);

    await handler(event());

    expect(directory.linkProvider).not.toHaveBeenCalled();
  });

  test("fails the sign-up when linking fails, instead of creating a second account", async () => {
    const { directory, handler } = fakeDirectory([nativeUser()]);
    directory.linkProvider.mockRejectedValueOnce(new Error("throttled"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(event())).rejects.toThrow("throttled");
  });

  test.each([
    ["another provider", "Facebook_123"],
    ["no provider prefix", "nounderscore"],
  ])("passes %s through", async (_, userName) => {
    const { directory, handler } = fakeDirectory([nativeUser()]);

    await handler(event({ userName }));

    expect(directory.findByEmail).not.toHaveBeenCalled();
  });

  test("skips emails that can't go into a ListUsers filter", async () => {
    const { directory, handler } = fakeDirectory([nativeUser()]);

    await handler(event({}, { email: 'a"b@example.com' }));

    expect(directory.findByEmail).not.toHaveBeenCalled();
  });
});

describe("email/password sign-up (PreSignUp_SignUp)", () => {
  const signUp = (users: PoolUser[]) => {
    const fake = fakeDirectory(users);
    return {
      ...fake,
      run: () =>
        fake.handler(
          event(
            { triggerSource: "PreSignUp_SignUp", userName: NATIVE },
            { email_verified: undefined },
          ),
        ),
    };
  };

  test("is refused when a Google user already has the email", async () => {
    const { run } = signUp([googleUser()]);

    await expect(run()).rejects.toThrow(EMAIL_TAKEN_MESSAGE);
  });

  test("goes ahead for a new email", async () => {
    const { run, directory } = signUp([]);

    await expect(run()).resolves.toBeDefined();
    expect(directory.linkProvider).not.toHaveBeenCalled();
  });

  test.each([
    ["unverified", googleUser({ emailVerified: false })],
    ["disabled", googleUser({ enabled: false })],
  ])("goes ahead when the Google user's email is %s", async (_, user) => {
    const { run } = signUp([user]);

    await expect(run()).resolves.toBeDefined();
  });
});

test("admin-created users pass through untouched", async () => {
  const { directory, handler } = fakeDirectory([googleUser()]);

  await handler(event({ triggerSource: "PreSignUp_AdminCreateUser", userName: NATIVE }));

  expect(directory.findByEmail).not.toHaveBeenCalled();
});

test("parseExternalUserName", () => {
  expect(parseExternalUserName("Google_123")).toEqual({
    provider: "Google",
    providerUserId: "123",
  });
  expect(parseExternalUserName("Google_")).toBeNull();
  expect(parseExternalUserName("_123")).toBeNull();
  expect(parseExternalUserName("SignInWithApple_123")).toBeNull();
});

describe("cognitoPoolDirectory", () => {
  function client(output: unknown = {}) {
    const send = vi.fn(async (_command: { input: unknown }) => output);
    return {
      send,
      directory: cognitoPoolDirectory({ send } as unknown as CognitoIdentityProviderClient),
    };
  }

  test("finds users by email", async () => {
    const { send, directory } = client({
      Users: [
        {
          Username: NATIVE,
          UserStatus: "CONFIRMED",
          Enabled: true,
          Attributes: [{ Name: "email_verified", Value: "true" }],
        },
        { Username: "Google_1", UserStatus: "EXTERNAL_PROVIDER", Enabled: false, Attributes: [] },
      ],
    });

    await expect(directory.findByEmail(POOL, "edgar@example.com")).resolves.toEqual([
      { username: NATIVE, status: "CONFIRMED", enabled: true, emailVerified: true },
      { username: "Google_1", status: "EXTERNAL_PROVIDER", enabled: false, emailVerified: false },
    ]);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      UserPoolId: POOL,
      Filter: 'email = "edgar@example.com"',
    });
  });

  test("links the provider's subject to the native user", async () => {
    const { send, directory } = client();

    await directory.linkProvider(POOL, NATIVE, "Google", GOOGLE_ID);

    expect(send.mock.calls[0]![0].input).toEqual({
      UserPoolId: POOL,
      DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: NATIVE },
      SourceUser: {
        ProviderName: "Google",
        ProviderAttributeName: "Cognito_Subject",
        ProviderAttributeValue: GOOGLE_ID,
      },
    });
  });
});
