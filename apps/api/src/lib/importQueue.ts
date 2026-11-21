import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ImportMessage } from "@photo-app/shared";

/**
 * The import queue (§10.1, `photo-app-{env}-imports`). The API only sends the `list` message once
 * the user is done picking; the import worker (13.5d) sends the `copy` messages. Messages never
 * carry the Google token (NFR-SEC-10).
 */
export interface ImportQueue {
  send(message: ImportMessage): Promise<void>;
}

export function sqsImportQueue(client: SQSClient, queueUrl: string): ImportQueue {
  return {
    async send(message) {
      await client.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }),
      );
    },
  };
}
