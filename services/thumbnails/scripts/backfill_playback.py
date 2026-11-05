"""One-off backfill (14.9): playback copies for videos processed before the video Lambda made them.

Sends one message per `ready` video without `playbackStatus` to the video queue, in the shape of
the daily sweep's retries (an S3 notification record). The Lambda finds the video `ready`, skips
the poster and makes only the copy (`VideoProcessor._make_playback`). Idempotent: a video whose
copy exists or is being made has `playbackStatus`, so a second run sends nothing for it. Run after
the video Lambda with 14.9 is deployed.

    AWS_PROFILE=dev uv run python scripts/backfill_playback.py \
        photo-app-dev photo-app-photos-dev-<account id> <video queue URL> [--dry-run]
"""

import json
import sys
from typing import Any

import boto3


def main() -> None:
    table, bucket, queue_url = sys.argv[1], sys.argv[2], sys.argv[3]
    dry_run = "--dry-run" in sys.argv[4:]
    ddb, sqs = boto3.client("dynamodb"), boto3.client("sqs")

    videos: list[dict[str, Any]] = []
    for page in ddb.get_paginator("scan").paginate(
        TableName=table,
        FilterExpression="begins_with(PK, :user) AND begins_with(SK, :photo) "
        "AND mediaType = :video AND #status = :ready AND attribute_not_exists(playbackStatus)",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":user": {"S": "USER#"},
            ":photo": {"S": "PHOTO#"},
            ":video": {"S": "video"},
            ":ready": {"S": "ready"},
        },
        ProjectionExpression="originalKey, sizeBytes, durationMs, fileName",
    ):
        videos += page["Items"]

    for item in videos:
        key = item["originalKey"]["S"]
        record = {
            "eventTime": None,
            "s3": {
                "bucket": {"name": bucket},
                "object": {"key": key, "size": int(item["sizeBytes"]["N"])},
            },
        }
        seconds = int(item.get("durationMs", {}).get("N", "0")) / 1000
        print(f"{'would send' if dry_run else 'send'} {key} ({seconds:.0f} s)")
        if not dry_run:
            sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps({"Records": [record]}))
    print(f"{len(videos)} video(s){' (dry run)' if dry_run else ''}")


if __name__ == "__main__":
    main()
