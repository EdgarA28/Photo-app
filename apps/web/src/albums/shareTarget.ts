import { usernameSchema, type CreateShareRequest } from "@photo-app/shared";
import { z } from "zod";

// Same normalisation as `createShareRequestSchema`'s email branch.
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export type ShareTarget =
  { ok: true; request: CreateShareRequest; label: string } | { ok: false; reason: string };

/**
 * Reads the share field (8.12): an `@` inside the value means an email (FR-SHR-1); otherwise it's a
 * username, with or without a leading `@` (FR-SHR-5). Validated with the API's own rules, so a
 * malformed value is explained before anything is sent. Null while the field is empty.
 */
export function parseShareTarget(input: string): ShareTarget | null {
  const value = input.trim();
  if (!value) return null;
  if (value.indexOf("@") > 0) {
    const email = emailSchema.safeParse(value);
    return email.success
      ? { ok: true, request: { email: email.data }, label: email.data }
      : { ok: false, reason: "This isn't a valid email address." };
  }
  const username = usernameSchema.safeParse(value);
  return username.success
    ? { ok: true, request: { username: username.data }, label: `@${username.data}` }
    : { ok: false, reason: `Not a valid username (${username.error.issues[0]!.message}).` };
}
