"""Lambda entry point `thumbnails.handler.handler` (spec §10).

Triggered asynchronously by S3 `ObjectCreated:*` on prefix `users/`. Environment:
- TABLE_NAME: DynamoDB table (`photo-app-{env}`).

Logs are structured JSON via the Lambda JSON log format (configured in the `thumbnails`
module); `extra` fields become JSON keys.
"""

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


@cache
def _processor() -> Processor:
    # Created once per execution environment and reused across warm invocations.
    return Processor(boto3.client("s3"), boto3.client("dynamodb"), os.environ["TABLE_NAME"])


def handler(event: dict[str, Any], context: Any = None) -> dict[str, list[dict[str, str]]]:
    results = []
    for record in event.get("Records", []):
        s3 = record["s3"]
        bucket = s3["bucket"]["name"]
        key = unquote_plus(s3["object"]["key"])  # Event keys are URL-encoded.
        size = int(s3["object"].get("size", 0))
        etag = s3["object"].get("eTag")
        event_time = _parse_event_time(record.get("eventTime"))

        # Transient errors propagate: Lambda retries the whole event (idempotent per photo).
        outcome = _processor().process(bucket, key, size, event_time, etag)
        results.append({"key": key, "status": outcome.status, "reason": outcome.reason})
        if outcome.status == "skipped":
            logger.info("Skipped object", extra={"key": key, "reason": outcome.reason})
    return {"results": results}


def _parse_event_time(value: str | None) -> datetime:
    if value:
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return datetime.now(UTC)
