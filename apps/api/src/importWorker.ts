/**
 * Import worker Lambda (`importWorker.handler` in dist/importWorker.mjs; 13.5d, §10.1), triggered
 * by the import queue `photo-app-{env}-imports` with batch size 1 and at most 3 at a time. Same
 * repositories and storage as the API; Google's token comes from the Import item, so this Lambda
 * needs no Google secret (NFR-SEC-10).
 */
import { SQSClient } from "@aws-sdk/client-sqs";
import { loadImportWorkerConfig } from "./lib/config";
import { googlePhotosClient } from "./lib/google";
import { sqsImportQueue } from "./lib/importQueue";
import { handleRecord, type SqsRecord, type WorkerDeps } from "./lib/importWorker";
import { createS3Client, s3PhotoStorage } from "./lib/storage";
import { createDocumentClient, createRepositories } from "./repo";

const config = loadImportWorkerConfig();
const deps: WorkerDeps = {
  repos: createRepositories({ client: createDocumentClient(), table: config.tableName }),
  storage: s3PhotoStorage(createS3Client(), config.photoBucket),
  // Only the Picker media items, downloads and session deletes: no client ID or secret needed.
  google: googlePhotosClient({
    clientId: "",
    loadClientSecret: () => Promise.reject(new Error("The import worker has no client secret")),
  }),
  queue: sqsImportQueue(new SQSClient({}), config.importQueueUrl),
  defaultQuotaBytes: config.defaultQuotaBytes,
};

export async function handler(event: { Records: SqsRecord[] }): Promise<void> {
  // Batch size 1: a thrown error makes SQS deliver this one message again (DLQ after 5).
  for (const record of event.Records) {
    await handleRecord(deps, record);
  }
}
