/**
 * Structured logs (spec §10 "Logs"). The Lambda uses the JSON log format, which sets `timestamp`,
 * `level` (from the console method) and `requestId` itself; passing an object instead of a JSON
 * string keeps our fields queryable instead of escaped inside `message`.
 */
type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const write: Record<Level, (entry: object) => void> = {
  DEBUG: (entry) => console.debug(entry),
  INFO: (entry) => console.info(entry),
  WARN: (entry) => console.warn(entry),
  ERROR: (entry) => console.error(entry),
};

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  write[level]({ message, ...fields });
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error)
    return { errorName: err.name, errorMessage: err.message, stack: err.stack };
  return { error: String(err) };
}
