import { monotonicFactory } from "ulid";

/** Canonical ULID: 26 Crockford base32 chars, uppercase, first char 0-7 (timestamp must fit 48 bits). */
export const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Cognito `sub`: lowercase UUID. */
export const USER_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Monotonic so IDs generated within the same millisecond still sort in creation order.
const nextUlid = monotonicFactory();

/** New ID for photos and albums (§8.1). */
export function newId(): string {
  return nextUlid();
}

export function isId(value: string): boolean {
  return ULID_REGEX.test(value);
}

export function isUserId(value: string): boolean {
  return USER_ID_REGEX.test(value);
}
