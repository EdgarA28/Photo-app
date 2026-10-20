/** Runtime configuration from Lambda environment variables (set by the `api` infra module, 5.4). */
export interface Config {
  tableName: string;
  /** Cognito user pool for profile and email lookups (GET /me, sharing). */
  userPoolId: string;
  /** Quota for users without a per-user override in their Usage item (FR-ACC-2). */
  defaultQuotaBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tableName: required(env, "TABLE_NAME"),
    userPoolId: required(env, "USER_POOL_ID"),
    defaultQuotaBytes: positiveInteger(env, "DEFAULT_QUOTA_BYTES"),
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
