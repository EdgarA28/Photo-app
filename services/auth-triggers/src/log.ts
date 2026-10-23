/** One JSON object per line; CloudWatch Logs Insights can query the fields (spec §10 "Logs"). */
type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error)
    return { errorName: err.name, errorMessage: err.message, stack: err.stack };
  return { error: String(err) };
}
