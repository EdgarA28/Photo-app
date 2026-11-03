"""Lambda entry point `thumbnails.video_handler.handler` (spec §10.2, 14.3).

Triggered by the SQS queue `photo-app-{env}-videos` (14.4): EventBridge `Object Created` events
for originals ending in `.mp4` / `.mov`, and the daily sweep's retries. One message per
invocation (batch size 1, maximum concurrency 2). Message handling and retries: `events.py`;
the processing: `video_processor.py`.

Packaged on its own (`dist-video/`: Pillow + PyAV, no pillow-heif), see build.sh.

Environment:
- TABLE_NAME: DynamoDB table (`photo-app-{env}`).
"""

import logging
import os
from functools import cache
from typing import Any

import boto3

from . import events
from .video_processor import VideoProcessor

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# A video takes up to tens of seconds (big index, 4K HEVC poster); with less time left the
# message goes back to the queue instead of being cut off by the timeout.
MIN_REMAINING_MS = 60_000


@cache
def _processor() -> VideoProcessor:
    # Created once per execution environment and reused across warm invocations.
    return VideoProcessor(boto3.client("s3"), boto3.client("dynamodb"), os.environ["TABLE_NAME"])


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    return events.handle(event, context, _processor(), MIN_REMAINING_MS)
