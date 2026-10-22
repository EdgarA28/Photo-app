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
   * The registered user with this verified email, for sharing (FR-SHR-1). `email` must already
   * be normalised (trimmed, lowercase). null if nobody who can sign in has it verified, or if
   * several users do.
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
          // skipped below.
          Limit: 10,
        }),
      );
      const matches = new Set<string>();
      for (const user of output.Users ?? []) {
        // Unconfirmed sign-ups and disabled users can't sign in to see the album.
        if (user.Enabled === false || user.UserStatus === "UNCONFIRMED") continue;
        const attribute = (name: string) => user.Attributes?.find((a) => a.Name === name)?.Value;
        // Only a verified address proves the user owns it: an unverified one may have been set
        // by its holder to someone else's email, to receive the shares meant for them.
        if (attribute("email_verified") !== "true") continue;
        const sub = attribute("sub");
        if (sub && isUserId(sub)) matches.add(sub);
      }
      // Pre-sign-up linking (4.5) should make this impossible; never guess between two people.
      if (matches.size !== 1) return null;
      return { userId: [...matches][0]!, email };
    },
  };
}
