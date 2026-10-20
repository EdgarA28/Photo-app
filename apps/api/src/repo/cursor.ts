import { validationError } from "../lib/errors";

/**
 * Opaque pagination cursor (§9): the last returned item's key attributes as base64url JSON.
 *
 * Decoding is strict because the cursor comes from the client: it must contain exactly the
 * expected key attributes as strings, and its partition attribute must equal the partition being
 * queried. That way a crafted cursor can never steer a query into another user's data.
 */
export type CursorKey = Record<string, string>;

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeCursor(
  cursor: string,
  attributes: readonly string[],
  partition: { attribute: string; value: string },
): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();

  const entries = Object.entries(parsed);
  const expected = new Set(attributes);
  if (entries.length !== expected.size) throw invalid();
  for (const [name, value] of entries) {
    if (!expected.has(name) || typeof value !== "string" || value.length === 0) throw invalid();
  }
  const key = parsed as CursorKey;
  if (key[partition.attribute] !== partition.value) throw invalid();
  return key;
}

function invalid() {
  return validationError("Invalid cursor");
}
