import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { getSignedCookies, getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { MEDIA_COOKIE_TTL_SECONDS, SHARED_IMAGE_URL_TTL_SECONDS } from "@photo-app/shared";
import { createPrivateKey, type KeyObject } from "node:crypto";

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

/** Signs CloudFront access to images: cookies for own ones (7.3), URLs for shared ones (7.4). */
export interface MediaSigner {
  signCookies(userId: string, now: Date): Promise<MediaCookies>;
  /**
   * One image seen through an album shared with the caller (7.4, §9): `path` (`/users/…`) with a
   * canned-policy signature for exactly that URL, valid 15 min, or until `until` if given (a
   * public photo link's end, FR-SHR-8). Relative, like own image paths, so it works on CloudFront
   * and through the dev proxy.
   */
  signUrl(path: string, now: Date, until?: Date): Promise<string>;
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
  // Parsed once: decoding the PEM on every signature nearly doubled its cost, and a shared album
  // page signs two URLs per photo (7.4). The signer passes the key straight to node:crypto's
  // sign(), which takes a KeyObject; its types only say string | Buffer.
  let parsed: { pem: string; key: KeyObject } | undefined;
  async function privateKey(): Promise<string> {
    const pem = await loadPrivateKey();
    if (parsed?.pem !== pem) parsed = { pem, key: createPrivateKey(pem) };
    return parsed.key as unknown as string;
  }

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
        policy,
        privateKey: await privateKey(),
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

    async signUrl(path, now, until) {
      const signed = getSignedUrl({
        url: `${origin}${path}`,
        keyPairId,
        privateKey: await privateKey(),
        dateLessThan: until
          ? new Date(Math.floor(until.getTime() / 1000) * 1000)
          : new Date((Math.floor(now.getTime() / 1000) + SHARED_IMAGE_URL_TTL_SECONDS) * 1000),
        algorithm: "SHA256",
      });
      return signed.slice(origin.length);
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
