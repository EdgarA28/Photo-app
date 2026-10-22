import {
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { isUserId } from "@photo-app/shared";

export interface UserProfile {
  email: string;
  name: string | null;
}

export interface DirectoryUser {
  userId: string;
  email: string;
}

/**
 * Cognito users as the API needs them. The access token carries only `sub` (no email or name),
 * so profile data is read from the user pool. Routes depend on this interface; tests use a fake.
 */
export interface UserDirectory {
  /** null if the user no longer exists in the pool. */
  getProfile(userId: string): Promise<UserProfile | null>;
  /**
   * The registered user with this email, for sharing (FR-SHR-1). `email` must already be
   * normalised (trimmed, lowercase). null if nobody who can sign in has it.
   */
  findByEmail(email: string): Promise<DirectoryUser | null>;
}

export function cognitoUserDirectory(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): UserDirectory {
  return {
    async getProfile(userId) {
      // The value is interpolated into a filter string, so only accept a well-formed sub.
      if (!isUserId(userId)) return null;
      // ListUsers by sub works for native and federated users alike; AdminGetUser only takes
      // usernames, which differ from the sub for Google users (`Google_…`).
      const output = await client.send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `sub = "${userId}"`,
          Limit: 1,
        }),
      );
      const attributes = output.Users?.[0]?.Attributes ?? [];
      const attribute = (name: string) => attributes.find((a) => a.Name === name)?.Value;
      const email = attribute("email");
      if (!email) return null;
      return { email, name: attribute("name") || null };
    },

    async findByEmail(email) {
      // Interpolated into a filter string too; validated emails never contain these anyway.
      if (/["\\]/.test(email)) return null;
      const output = await client.send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `email = "${email}"`,
          // Pre-sign-up linking (4.5) keeps one user per email; a few more cover the leftovers
          // below (unconfirmed sign-ups, disabled users).
          Limit: 10,
        }),
      );
      for (const user of output.Users ?? []) {
        // Unconfirmed sign-ups haven't proved they own the address, and neither they nor
        // disabled users can sign in to see the album.
        if (user.Enabled === false || user.UserStatus === "UNCONFIRMED") continue;
        const sub = user.Attributes?.find((a) => a.Name === "sub")?.Value;
        if (sub && isUserId(sub)) return { userId: sub, email };
      }
      return null;
    },
  };
}
