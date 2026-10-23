import {
  AdminLinkProviderForUserCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

export interface PoolUser {
  /** Cognito username: the `sub` for native users (email sign-in), `Google_…` for federated ones. */
  username: string;
  /** `CONFIRMED`, `UNCONFIRMED`, `EXTERNAL_PROVIDER`, … */
  status: string | undefined;
  enabled: boolean;
  emailVerified: boolean;
}

/** The user pool as the trigger needs it. The handler depends on this interface; tests use a fake. */
export interface PoolDirectory {
  /** Users whose `email` matches (Cognito compares case-insensitively, see ARCHITECTURE §12.3). */
  findByEmail(userPoolId: string, email: string): Promise<PoolUser[]>;
  /** Makes the external identity sign in as the existing native user from now on (FR-AUTH-3). */
  linkProvider(
    userPoolId: string,
    nativeUsername: string,
    providerName: string,
    providerUserId: string,
  ): Promise<void>;
}

export function cognitoPoolDirectory(client: CognitoIdentityProviderClient): PoolDirectory {
  return {
    async findByEmail(userPoolId, email) {
      const output = await client.send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `email = "${email}"`,
          // One account per email is the goal; a few more cover leftovers (unconfirmed sign-ups).
          Limit: 10,
        }),
      );
      return (output.Users ?? []).map((user) => ({
        username: user.Username ?? "",
        status: user.UserStatus,
        enabled: user.Enabled !== false,
        emailVerified: user.Attributes?.find((a) => a.Name === "email_verified")?.Value === "true",
      }));
    },

    async linkProvider(userPoolId, nativeUsername, providerName, providerUserId) {
      await client.send(
        new AdminLinkProviderForUserCommand({
          UserPoolId: userPoolId,
          DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: nativeUsername },
          SourceUser: {
            ProviderName: providerName,
            // The provider's own user ID (Google's `sub`), as in the `Google_<id>` username.
            ProviderAttributeName: "Cognito_Subject",
            ProviderAttributeValue: providerUserId,
          },
        }),
      );
    },
  };
}
