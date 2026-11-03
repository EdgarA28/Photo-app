"""SQS / S3 event handling shared by both Lambdas (spec §10, §10.2, 13.6): `handler.py` (photos)
and `video_handler.py` (videos) differ only in their processor and time margin.

Messages are EventBridge `Object Created` events (from the originals rules) or S3 notification
events (`Records`: the daily sweep's retries, apps/api `thumbnailRetry.ts`). Transient errors put
the message in `batchItemFailures` (the mappings use `ReportBatchItemFailures`): it comes back
after the visibility timeout, and after 5 receives SQS moves it to the DLQ. Permanent errors are
handled by the processor (`failed`, success). Direct S3 events (the photo trigger before 13.6) are
still accepted; there a transient error raises, and Lambda's async retries apply.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import unquote_plus

logger = logging.getLogger(__name__)


class Outcome(Protocol):
    status: str
    reason: str


class OriginalProcessor(Protocol):
    def process(
        self, bucket: str, key: str, size: int, event_time: datetime, etag: str | None = None
    ) -> Outcome: ...


def handle(
    event: dict[str, Any], context: Any, processor: OriginalProcessor, min_remaining_ms: int
) -> dict[str, Any]:
    records = event.get("Records", [])
    if records and all(r.get("eventSource") == "aws:sqs" for r in records):
        return _handle_sqs(records, context, processor, min_remaining_ms)
    # Transient errors propagate: Lambda retries the whole event (idempotent per photo).
    return {"results": [_process_s3_record(r, processor) for r in records]}


def _handle_sqs(
    messages: list[dict[str, Any]],
    context: Any,
    processor: OriginalProcessor,
    min_remaining_ms: int,
) -> dict[str, Any]:
    failures: list[dict[str, str]] = []
    for i, message in enumerate(messages):
        if context is not None and context.get_remaining_time_in_millis() < min_remaining_ms:
            left = messages[i:]
            logger.warning("Out of time, returning messages", extra={"count": len(left)})
            failures.extend({"itemIdentifier": m["messageId"]} for m in left)
            break
        try:
            body = json.loads(message["body"])
            # S3 sends `s3:TestEvent` (no Records) when a notification is saved.
            for record in _s3_records(body):
                _process_s3_record(record, processor)
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


def _process_s3_record(
    record: dict[str, Any], processor: OriginalProcessor
) -> dict[str, str | None]:
    s3 = record["s3"]
    bucket = s3["bucket"]["name"]
    key = unquote_plus(s3["object"]["key"])  # Event keys are URL-encoded.
    size = int(s3["object"].get("size", 0))
    etag = s3["object"].get("eTag")
    event_time = _parse_event_time(record.get("eventTime"))

    outcome = processor.process(bucket, key, size, event_time, etag)
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
