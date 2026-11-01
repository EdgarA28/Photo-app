import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { PhotoRecord } from "../repo";

/**
 * Asks the thumbnail Lambda to process a photo again (6.11, 13.6): a photo still `pending` a day
 * after its original arrived lost its queue messages (dev 2026-11-01: the event source mapping
 * received some messages without invoking the function, and after 3 receives they went to the
 * DLQ). The daily sweep sends one new message for it to the thumbnail queue.
 */
export type RetryProcessing = (record: PhotoRecord) => Promise<void>;

/**
 * The message has the shape of the S3 event the queue normally carries (services/thumbnails
 * `handler._process_s3_record`): bucket, key, size and time. No eTag: it is only compared for
 * photos that are no longer pending, and processing reads the bytes' own ETag. Processing is
 * idempotent (status condition), so a photo that got processed meanwhile is just skipped.
 */
export function sqsRetryProcessing(
  client: SQSClient,
  queueUrl: string,
  bucket: string,
): RetryProcessing {
  return async (record) => {
    const body = {
      Records: [
        {
          eventSource: "aws:s3",
          eventName: "ObjectCreated:Retry",
          // Only a fallback for takenAt when the item has no uploadedAt (it always has one).
          eventTime: record.uploadedAt,
          s3: {
            bucket: { name: bucket },
            // S3 event keys are URL-encoded; ours are plain ASCII, so this changes nothing.
            object: {
              key: encodeURIComponent(record.originalKey).replaceAll("%2F", "/"),
              size: record.sizeBytes,
            },
          },
        },
      ],
    };
    await client.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body) }),
    );
  };
}
