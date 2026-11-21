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

/**
 * Import from Google Photos (13.5c, §11.5). Optional until the infra provides it (13.5f): without
 * `GOOGLE_CLIENT_ID` the `/imports` routes aren't registered (404), and nothing else changes.
 */
export interface ImportConfig {
  googleClientId: string;
  /** SSM SecureString with the Google client secret (NFR-SEC-10). */
  googleClientSecretParameter: string;
  importQueueUrl: string;
  /** App origins Google may redirect back to (`{origin}/import/google/callback`). */
  redirectOrigins: string[];
}

export function loadImportConfig(env: NodeJS.ProcessEnv = process.env): ImportConfig | null {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const redirectOrigins = required(env, "IMPORT_REDIRECT_ORIGINS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of redirectOrigins) {
    if (!/^https?:\/\/[^/]+$/.test(value)) {
      throw new Error("IMPORT_REDIRECT_ORIGINS must be http(s) origins without a path");
    }
  }
  if (redirectOrigins.length === 0) throw new Error("IMPORT_REDIRECT_ORIGINS is empty");
  return {
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecretParameter: required(env, "GOOGLE_CLIENT_SECRET_PARAMETER"),
    importQueueUrl: required(env, "IMPORT_QUEUE_URL"),
    redirectOrigins,
  };
}

/**
 * The import worker (13.5d, §10.1): table, photo bucket, its own queue (copy messages) and the
 * default quota (copies count against it like uploads). No Google secret: it uses the token the
 * API stored in the Import item.
 */
export function loadImportWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    tableName: required(env, "TABLE_NAME"),
    photoBucket: required(env, "PHOTO_BUCKET"),
    importQueueUrl: required(env, "IMPORT_QUEUE_URL"),
    defaultQuotaBytes: positiveInteger(env, "DEFAULT_QUOTA_BYTES"),
  };
}

/** The trash purge Lambda (FR-DEL-3, `purge.ts`): only the table and the photo bucket. */
export function loadPurgeConfig(env: NodeJS.ProcessEnv = process.env): Pick<
  Config,
  "tableName" | "photoBucket"
> & {
  thumbnailQueueUrl: string;
  videoQueueUrl: string;
} {
  return {
    tableName: required(env, "TABLE_NAME"),
    photoBucket: required(env, "PHOTO_BUCKET"),
    // Stuck photos go back to the thumbnail queue (6.11, 13.6), stuck videos to the video queue
    // (14.4).
    thumbnailQueueUrl: required(env, "THUMBNAIL_QUEUE_URL"),
    videoQueueUrl: required(env, "VIDEO_QUEUE_URL"),
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
