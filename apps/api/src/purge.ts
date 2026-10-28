/**
 * Trash purge Lambda (`purge.handler` in dist/purge.mjs, FR-DEL-3): run once a day by an
 * EventBridge schedule (api infra module), deletes every trashed photo whose 15 days are up.
 * Shares the repositories and storage with the API; needs only the table and the photo bucket.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { loadPurgeConfig } from "./lib/config";
import { log } from "./lib/log";
import { s3PhotoStorage } from "./lib/storage";
import { purgeExpired } from "./lib/trash";
import { createDocumentClient, createRepositories } from "./repo";

const config = loadPurgeConfig();
const repos = createRepositories({ client: createDocumentClient(), table: config.tableName });
const storage = s3PhotoStorage(new S3Client({}), config.photoBucket);

export async function handler(): Promise<void> {
  const result = await purgeExpired(repos, storage, new Date());
  log(result.failed ? "WARN" : "INFO", "Trash purge done", { ...result });
  // Failures are retried by the next daily run; a failed invocation makes them visible in metrics.
  if (result.failed) throw new Error(`${result.failed} trashed photos could not be purged`);
}
