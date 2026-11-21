import {
  idSchema,
  MAX_PHOTOS_PER_IMPORT,
  newId,
  startGoogleImportRequestSchema,
  type Import,
  type StartGoogleImportResponse,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, orNotFound, validationError } from "../lib/errors";
import { GoogleApiError, type GooglePhotos } from "../lib/google";
import type { ImportQueue } from "../lib/importQueue";
import { errorFields, log } from "../lib/log";
import { validate } from "../lib/validation";
import type { ImportRecord, Repositories } from "../repo";
import type { Deps } from ".";

/** What the import routes need besides the repositories; absent until 13.5f configures it. */
export interface ImportDeps {
  google: GooglePhotos;
  queue: ImportQueue;
  /** App origins allowed in `redirectUri` (§11.5). */
  redirectOrigins: string[];
}

/**
 * A copy that started just before Google's token ran out can still finish (worker timeout 120 s,
 * §10.1), so an import still listing or copying is closed as expired only this long after.
 */
export const EXPIRY_GRACE_MS = 3 * 60 * 1000;

const importParam = z.object({ importId: idSchema });

/**
 * Import from Google Photos (13.5c; FR-IMP-1/2/5, §5.2, §9, NFR-SEC-10). Imports live under the
 * caller's `sub`, so another user's import is 404 like a missing one (NFR-SEC-1/2). The Google
 * token never leaves the backend: responses carry the import's progress only.
 */
export function importRoutes(app: Hono<AppEnv>, { repos }: Deps, deps: ImportDeps): void {
  /** Exchanges Google's code, opens a Picker session and stores the import (`picking`). */
  app.post("/imports/google", validate("json", startGoogleImportRequestSchema), async (c) => {
    const request = c.req.valid("json");
    if (!deps.redirectOrigins.includes(new URL(request.redirectUri).origin)) {
      throw validationError("redirectUri: not an origin of this app");
    }
    const token = await deps.google.exchangeCode(request);
    if (!token) {
      throw new AppError(400, "GOOGLE_AUTH_FAILED", "Google didn't accept the authorization");
    }
    const session = await deps.google.createSession(token.accessToken, MAX_PHOTOS_PER_IMPORT);
    const record = await repos.imports.create({
      userId: c.get("userId"),
      importId: newId(),
      source: "google-photos",
      sessionId: session.sessionId,
      pickerUri: session.pickerUri,
      pollIntervalSec: session.pollIntervalSec,
      accessToken: token.accessToken,
      tokenExpiresAt: token.expiresAt.toISOString(),
      sessionExpiresAt: session.expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
    });
    log("INFO", "Import started", { userId: record.userId, importId: record.importId });
    const body: StartGoogleImportResponse = {
      importId: record.importId,
      pickerUri: record.pickerUri,
      expiresAt: pickingEndsAt(record),
    };
    return c.json(body, 201);
  });

  /**
   * Progress (FR-IMP-5). While `picking` it asks Google whether the user is done (at most once
   * per poll interval) and then hands the import to the worker; it also closes imports whose
   * token or Picker session ran out.
   */
  app.get("/imports/:importId", validate("param", importParam), async (c) => {
    const { importId } = c.req.valid("param");
    const userId = c.get("userId");
    let record = orNotFound(await repos.imports.get(userId, importId), "Import not found");
    record = await advance(repos, deps, record, new Date());
    return c.json(toImport(record));
  });

  /** Cancel (FR-IMP-5): photos already copied stay; queued copies see `cancelled` and stop. */
  app.delete("/imports/:importId", validate("param", importParam), async (c) => {
    const { importId } = c.req.valid("param");
    const userId = c.get("userId");
    let record = orNotFound(await repos.imports.get(userId, importId), "Import not found");
    // A copy finishing meanwhile changes the counters the update is conditional on: read again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const ended = await repos.imports.end(record, "cancelled");
      if (ended || !isActive(record)) {
        if (ended) await closeSession(deps, record, "cancelled");
        return c.body(null, 204);
      }
      record = orNotFound(await repos.imports.get(userId, importId), "Import not found");
    }
    throw new AppError(409, "CONFLICT", "The import changed meanwhile, try again");
  });
}

/** One step of the import's life from the API's side, as far as `now` allows. */
async function advance(
  repos: Repositories,
  deps: ImportDeps,
  record: ImportRecord,
  now: Date,
): Promise<ImportRecord> {
  if (record.status === "picking") {
    if (now.toISOString() >= pickingEndsAt(record)) return expire(repos, deps, record);
    if (!(await repos.imports.claimPoll(record.userId, record.importId, now))) return record;
    let session;
    try {
      session = await deps.google.getSession(record.accessToken ?? "", record.sessionId);
    } catch (err) {
      // The token was revoked: nothing more can happen. Anything else: try again next poll.
      if (err instanceof GoogleApiError && err.unauthorized) return expire(repos, deps, record);
      log("WARN", "Picker session poll failed", { importId: record.importId, ...errorFields(err) });
      return record;
    }
    if (!session) return expire(repos, deps, record);
    if (!session.mediaItemsSet) return record;
    if (!(await repos.imports.startListing(record.userId, record.importId))) {
      return (await repos.imports.get(record.userId, record.importId)) ?? record;
    }
    try {
      await deps.queue.send({ type: "list", userId: record.userId, importId: record.importId });
    } catch (err) {
      // Back to picking, so the next poll sends it again; the app shows no error for this.
      await repos.imports.backToPicking(record.userId, record.importId);
      log("ERROR", "Import list message not sent", {
        importId: record.importId,
        ...errorFields(err),
      });
      return record;
    }
    log("INFO", "Import picked", { userId: record.userId, importId: record.importId });
    return { ...record, status: "listing" };
  }
  if (
    (record.status === "listing" || record.status === "copying") &&
    now.getTime() >= Date.parse(record.tokenExpiresAt) + EXPIRY_GRACE_MS
  ) {
    return expire(repos, deps, record);
  }
  return record;
}

/** Ends the import as `expired`; on a race, the import as it now is. */
async function expire(
  repos: Repositories,
  deps: ImportDeps,
  record: ImportRecord,
): Promise<ImportRecord> {
  const ended = await repos.imports.end(record, "expired");
  if (!ended) return (await repos.imports.get(record.userId, record.importId)) ?? record;
  await closeSession(deps, record, "expired");
  return ended;
}

/** Deletes the Picker session while the token still works; Google expires it anyway. */
async function closeSession(deps: ImportDeps, record: ImportRecord, outcome: string) {
  log("INFO", `Import ${outcome}`, { userId: record.userId, importId: record.importId });
  if (!record.accessToken || Date.parse(record.tokenExpiresAt) <= Date.now()) return;
  try {
    await deps.google.deleteSession(record.accessToken, record.sessionId);
  } catch (err) {
    log("WARN", "Picker session not deleted", { importId: record.importId, ...errorFields(err) });
  }
}

const isActive = (record: ImportRecord) =>
  record.status === "picking" || record.status === "listing" || record.status === "copying";

/** Picking must end before the token or the Picker session does, whichever comes first. */
const pickingEndsAt = (record: ImportRecord) =>
  record.tokenExpiresAt < record.sessionExpiresAt ? record.tokenExpiresAt : record.sessionExpiresAt;

function toImport(record: ImportRecord): Import {
  return {
    status: record.status,
    total: record.total,
    done: record.done,
    failed: record.failed,
    skipped: record.skipped,
    failedReasons: record.failedReasons,
  };
}
