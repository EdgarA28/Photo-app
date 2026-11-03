/**
 * Daily maintenance Lambda (`purge.handler` in dist/purge.mjs), run once a day by an EventBridge
 * schedule (api infra module):
 * - trash purge (FR-DEL-3): deletes every trashed photo whose 15 days are up;
 * - stale-pending sweep (6.11): deletes uploads started over a day ago that never arrived, which
 *   releases the quota they reserved (5.6b), and sends the ones whose original did arrive back to
 *   the thumbnail queue (13.6).
 * Shares the repositories and storage with the API; needs the table, the photo bucket and the
 * thumbnail queue.
 */
import { SQSClient } from "@aws-sdk/client-sqs";
import { loadPurgeConfig } from "./lib/config";
import { log } from "./lib/log";
import { sweepStalePending } from "./lib/pending";
import { createS3Client, s3PhotoStorage } from "./lib/storage";
import { sqsRetryProcessing } from "./lib/thumbnailRetry";
import { purgeExpired } from "./lib/trash";
import { createDocumentClient, createRepositories } from "./repo";

const config = loadPurgeConfig();
const repos = createRepositories({ client: createDocumentClient(), table: config.tableName });
const storage = s3PhotoStorage(createS3Client(), config.photoBucket);
const retryProcessing = sqsRetryProcessing(
  new SQSClient({}),
  config.thumbnailQueueUrl,
  config.photoBucket,
);

/** Room left at the end of the run for the work in flight and the final logs. */
const SAFETY_MARGIN_MS = 30_000;

/** The part of the Lambda context used here. */
interface Context {
  getRemainingTimeInMillis(): number;
}

export async function handler(_event?: unknown, context?: Context): Promise<void> {
  const purge = await purgeExpired(repos, storage, new Date());
  log(purge.failed ? "WARN" : "INFO", "Trash purge done", { ...purge });

  const deadline = context
    ? Date.now() + context.getRemainingTimeInMillis() - SAFETY_MARGIN_MS
    : undefined;
  const sweep = await sweepStalePending(repos, storage, new Date(), deadline, retryProcessing);
  log(sweep.failed || sweep.stuck ? "WARN" : "INFO", "Stale-pending sweep done", { ...sweep });

  // Failures are retried by the next daily run; a failed invocation makes them visible in metrics.
  const failed = purge.failed + sweep.failed;
  if (failed) throw new Error(`${failed} photos could not be purged or swept`);
}
