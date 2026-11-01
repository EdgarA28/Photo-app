"""Lambda entry point `thumbnails.handler.handler` (spec §10).

Triggered by the SQS queue `photo-app-{env}-thumbnails` (13.6). Its messages are:
- EventBridge `Object Created` events from the photo bucket, for originals only (the rule
  `photo-app-{env}-thumbnails-originals` matches `users/*/originals/*`), so the thumbs/previews
  written here never come back (Lambda's recursive loop detection dropped them, dev 2026-11-01);
- S3 notification events (`Records`): the daily sweep's retries (apps/api `thumbnailRetry.ts`)
  and messages queued before the switch to EventBridge.
Transient errors put that message in `batchItemFailures` (the mapping uses
`ReportBatchItemFailures`): it comes back after the visibility timeout, and after 5 receives SQS
moves it to the DLQ. Permanent errors are handled by the processor (`failed`, success).

Direct S3 events (the trigger before 13.6) are still accepted, so events sent just before the
switch don't fail: there a transient error raises, and Lambda's async retries apply.

Environment:
- TABLE_NAME: DynamoDB table (`photo-app-{env}`).

Logs are structured JSON via the Lambda JSON log format (configured in the `thumbnails`
module); `extra` fields become JSON keys.
"""

import json
import logging
import os
from datetime import UTC, datetime
from functools import cache
from typing import Any
from urllib.parse import unquote_plus

import boto3

from .processor import Processor

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Stop starting new messages when less time is left (a large HEIC takes several seconds); the
# rest go back to the queue instead of being cut off by the timeout with the whole batch.
MIN_REMAINING_MS = 20_000


@cache
def _processor() -> Processor:
    # Created once per execution environment and reused across warm invocations.
    return Processor(boto3.client("s3"), boto3.client("dynamodb"), os.environ["TABLE_NAME"])


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    records = event.get("Records", [])
    if records and all(r.get("eventSource") == "aws:sqs" for r in records):
        return _handle_sqs(records, context)
    # Transient errors propagate: Lambda retries the whole event (idempotent per photo).
    return {"results": [_process_s3_record(r) for r in records]}


def _handle_sqs(messages: list[dict[str, Any]], context: Any) -> dict[str, Any]:
    failures: list[dict[str, str]] = []
    for i, message in enumerate(messages):
        if context is not None and context.get_remaining_time_in_millis() < MIN_REMAINING_MS:
            left = messages[i:]
            logger.warning("Out of time, returning messages", extra={"count": len(left)})
            failures.extend({"itemIdentifier": m["messageId"]} for m in left)
            break
        try:
            body = json.loads(message["body"])
            # S3 sends `s3:TestEvent` (no Records) when a notification is saved.
            for record in _s3_records(body):
                _process_s3_record(record)
        except Exception:
            # Idempotent per photo, so retrying a message whose first record succeeded is safe.
            logger.exception(
                "Transient error, message will be retried",
                extra={
                    "messageId": message["messageId"],
                    "receiveCount": message.get("attributes", {}).get("ApproximateReceiveCount"),
                },
            )
            failures.append({"itemIdentifier": message["messageId"]})
    # Only this key: anything else in the response would fail the whole batch.
    return {"batchItemFailures": failures}


def _s3_records(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The S3 records of a message body, an EventBridge event turned into the notification shape."""
    if body.get("source") == "aws.s3" and isinstance(body.get("detail"), dict):
        detail = body["detail"]
        obj = detail.get("object", {})
        return [
            {
                "eventTime": body.get("time"),
                "s3": {
                    "bucket": {"name": detail["bucket"]["name"]},
                    # Plain key in EventBridge; unquote_plus below doesn't change ours (ASCII,
                    # no `+` or `%`, §8.1).
                    "object": {
                        "key": obj["key"],
                        "size": obj.get("size", 0),
                        "eTag": obj.get("etag"),
                    },
                },
            }
        ]
    return body.get("Records", [])


def _process_s3_record(record: dict[str, Any]) -> dict[str, str | None]:
    s3 = record["s3"]
    bucket = s3["bucket"]["name"]
    key = unquote_plus(s3["object"]["key"])  # Event keys are URL-encoded.
    size = int(s3["object"].get("size", 0))
    etag = s3["object"].get("eTag")
    event_time = _parse_event_time(record.get("eventTime"))

    outcome = _processor().process(bucket, key, size, event_time, etag)
    if outcome.status == "skipped":
        logger.info("Skipped object", extra={"key": key, "reason": outcome.reason})
    return {"key": key, "status": outcome.status, "reason": outcome.reason}


def _parse_event_time(value: str | None) -> datetime:
    if value:
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return datetime.now(UTC)
