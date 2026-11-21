import { SendMessageBatchCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ImportMessage } from "@photo-app/shared";

/**
 * The import queue (§10.1, `photo-app-{env}-imports`). The API only sends the `list` message once
 * the user is done picking; the import worker (13.5d) sends the `copy` messages. Messages never
 * carry the Google token (NFR-SEC-10).
 */
export interface ImportQueue {
  send(message: ImportMessage): Promise<void>;
  /** Many messages, 10 per SQS call; throws if any of them wasn't accepted. */
  sendBatch(messages: ImportMessage[]): Promise<void>;
}

/** SQS takes at most 10 messages per `SendMessageBatch`. */
const BATCH_SIZE = 10;

export function sqsImportQueue(client: SQSClient, queueUrl: string): ImportQueue {
  return {
    async send(message) {
      await client.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }),
      );
    },

    async sendBatch(messages) {
      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const output = await client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: messages.slice(i, i + BATCH_SIZE).map((message, n) => ({
              Id: String(n),
              MessageBody: JSON.stringify(message),
            })),
          }),
        );
        // Redelivery of the `list` message sends them all again; claims stop duplicates.
        if (output.Failed?.length) {
          throw new Error(`${output.Failed.length} import messages were not sent`);
        }
      }
    },
  };
}
