/** Runtime configuration from Lambda environment variables (set by the `api` infra module, 5.4). */
export interface Config {
  tableName: string;
  /** Photo bucket for pre-signed uploads (5.6) and downloads (5.8). */
  photoBucket: string;
  /** Cognito user pool for profile and email lookups (GET /me, sharing). */
  userPoolId: string;
  /** Quota for users without a per-user override in their Usage item (FR-ACC-2). */
  defaultQuotaBytes: number;
  /** Media cookies (7.3): CloudFront origin, public key ID, SSM parameter with the private key. */
  mediaOrigin: string;
  mediaKeyPairId: string;
  mediaPrivateKeyParameter: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tableName: required(env, "TABLE_NAME"),
    photoBucket: required(env, "PHOTO_BUCKET"),
    userPoolId: required(env, "USER_POOL_ID"),
    defaultQuotaBytes: positiveInteger(env, "DEFAULT_QUOTA_BYTES"),
    mediaOrigin: origin(env, "MEDIA_ORIGIN"),
    mediaKeyPairId: required(env, "MEDIA_KEY_PAIR_ID"),
    mediaPrivateKeyParameter: required(env, "MEDIA_PRIVATE_KEY_PARAMETER"),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

/** `https://host`, no path or trailing slash: it prefixes the signed policy's resource. */
function origin(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^https:\/\/[^/]+$/.test(value)) {
    throw new Error(`Environment variable ${name} must be an https origin without a path`);
  }
  return value;
}
