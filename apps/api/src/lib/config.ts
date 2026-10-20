/** Runtime configuration from Lambda environment variables (set by the `api` infra module, 5.4). */
export interface Config {
  tableName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { tableName: required(env, "TABLE_NAME") };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
