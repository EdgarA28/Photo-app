import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { MEDIA_COOKIE_TTL_SECONDS } from "@photo-app/shared";

/**
 * Every cookie CloudFront reads for a custom-policy signature with SHA-256 (§9 media cookie).
 * SHA-256 adds `CloudFront-Hash-Algorithm` to the three of spec §9 (ARCHITECTURE.md §15).
 */
export const MEDIA_COOKIE_NAMES = [
  "CloudFront-Policy",
  "CloudFront-Signature",
  "CloudFront-Key-Pair-Id",
  "CloudFront-Hash-Algorithm",
] as const;

export interface MediaCookies {
  /** Cookie name → value, for every name in `MEDIA_COOKIE_NAMES`. */
  cookies: Record<(typeof MEDIA_COOKIE_NAMES)[number], string>;
  expiresAt: Date;
}

/** Signs CloudFront access to the user's own images (FR-AUTH-5 cookie, 7.3). Faked in tests. */
export interface MediaSigner {
  signCookies(userId: string, now: Date): Promise<MediaCookies>;
}

export interface MediaSignerOptions {
  /** `https://<distribution domain>`: the policy's resource must match what CloudFront sees. */
  origin: string;
  /** CloudFront public key ID (frontend module, 7.2). */
  keyPairId: string;
  loadPrivateKey: () => Promise<string>;
}

export function cloudFrontMediaSigner({
  origin,
  keyPairId,
  loadPrivateKey,
}: MediaSignerOptions): MediaSigner {
  return {
    async signCookies(userId, now) {
      // Whole seconds: the policy's epoch time and the reported expiresAt must be the same instant.
      const expiresEpoch = Math.floor(now.getTime() / 1000) + MEDIA_COOKIE_TTL_SECONDS;
      // Custom policy: the wildcard covers the user's whole prefix. Originals match it too, but
      // the photo bucket policy only lets CloudFront read thumbs/ and previews/ (7.1).
      const policy = JSON.stringify({
        Statement: [
          {
            Resource: `${origin}/users/${userId}/*`,
            Condition: { DateLessThan: { "AWS:EpochTime": expiresEpoch } },
          },
        ],
      });
      const signed = getSignedCookies({
        keyPairId,
        privateKey: await loadPrivateKey(),
        policy,
        algorithm: "SHA256",
      });
      const cookies = Object.fromEntries(
        MEDIA_COOKIE_NAMES.map((name) => {
          const value = signed[name];
          if (!value) throw new Error(`CloudFront signer returned no ${name}`);
          return [name, String(value)];
        }),
      ) as MediaCookies["cookies"];
      return { cookies, expiresAt: new Date(expiresEpoch * 1000) };
    },
  };
}

/**
 * Reads the signing key from SSM on first use and keeps it for the life of the execution
 * environment, so only media-cookie requests depend on SSM (not every cold start). A failed read
 * is not cached: the next request tries again.
 */
export function ssmPrivateKeyLoader(client: SSMClient, parameterName: string) {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= client
      .send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))
      .then((res) => {
        const value = res.Parameter?.Value;
        if (!value) throw new Error(`SSM parameter ${parameterName} has no value`);
        return value;
      })
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}
