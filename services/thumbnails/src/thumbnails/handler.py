"""Lambda entry point `thumbnails.handler.handler` (spec §10).

Triggered by the SQS queue `photo-app-{env}-thumbnails` (13.6). Its messages are:
- EventBridge `Object Created` events from the photo bucket, for originals only (the rule
  `photo-app-{env}-thumbnails-originals` matches `users/*/originals/*`), so the thumbs/previews
  written here never come back (Lambda's recursive loop detection dropped them, dev 2026-11-01);
- S3 notification events (`Records`): the daily sweep's retries (apps/api `thumbnailRetry.ts`)
  and messages queued before the switch to EventBridge.
Message handling and retries: `events.py`.

Environment:
- TABLE_NAME: DynamoDB table (`photo-app-{env}`).

Logs are structured JSON via the Lambda JSON log format (configured in the `thumbnails`
module); `extra` fields become JSON keys.
"""

import logging
import os
from functools import cache
from typing import Any

import boto3

from . import events
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
    return events.handle(event, context, _processor(), MIN_REMAINING_MS)
