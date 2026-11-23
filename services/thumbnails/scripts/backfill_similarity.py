"""One-off backfill (8.37c; FR-GAL-10/11/12, spec §10): `similarityHash` + `sharpness` for photos
processed before the thumbnail Lambda measured them (8.37a).

For each `ready` photo (not a video) without `similarityHash`: read its thumb and preview from S3
and write the values the Lambda writes for a new photo (`similarity.similarity` on the same
encoded JPEGs, `similarity.item_values`), so backfilled and new photos compare alike. Trashed
photos too, so a restored one can stack. Idempotent: photos that have a hash are skipped, and each
write is conditional on that and on the photo still being ready. Run after 8.37a is deployed, so
no photo processed meanwhile is missed.

    AWS_PROFILE=dev uv run python scripts/backfill_similarity.py \
        photo-app-dev photo-app-photos-dev-<account id> [--dry-run]
"""

import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from botocore.exceptions import ClientError

from thumbnails.s3_keys import preview_key, thumb_key
from thumbnails.similarity import SET_CLAUSE, item_values, similarity

# S3 GETs + ~50 ms of Pillow per photo; boto3 clients are thread-safe.
WORKERS = 8


def find_photos(ddb: Any, table: str) -> list[tuple[str, str]]:
    """(userId, photoId) of every ready photo without a hash. Missing `mediaType` = photo (§8.2)."""
    found: list[tuple[str, str]] = []
    for page in ddb.get_paginator("scan").paginate(
        TableName=table,
        FilterExpression="begins_with(PK, :user) AND begins_with(SK, :photo) "
        "AND #status = :ready AND attribute_not_exists(similarityHash) "
        "AND (attribute_not_exists(mediaType) OR mediaType = :photoType)",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":user": {"S": "USER#"},
            ":photo": {"S": "PHOTO#"},
            ":ready": {"S": "ready"},
            ":photoType": {"S": "photo"},
        },
        ProjectionExpression="PK, SK",
    ):
        for item in page["Items"]:
            found.append(
                (item["PK"]["S"].removeprefix("USER#"), item["SK"]["S"].removeprefix("PHOTO#"))
            )
    return found


def backfill_one(
    ddb: Any, s3: Any, table: str, bucket: str, user_id: str, photo_id: str, dry_run: bool
) -> str:
    """`written` / `would write`, `missing images` (thumb or preview gone, e.g. deleted
    meanwhile) or `changed` (deleted, no longer ready, or already has a hash)."""
    try:
        thumb = s3.get_object(Bucket=bucket, Key=thumb_key(user_id, photo_id))["Body"].read()
        preview = s3.get_object(Bucket=bucket, Key=preview_key(user_id, photo_id))["Body"].read()
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return "missing images"
        raise
    result = similarity(thumb, preview)
    if dry_run:
        return "would write"
    try:
        ddb.update_item(
            TableName=table,
            Key={"PK": {"S": f"USER#{user_id}"}, "SK": {"S": f"PHOTO#{photo_id}"}},
            UpdateExpression="SET " + SET_CLAUSE,
            ConditionExpression="attribute_exists(PK) AND #status = :ready "
            "AND attribute_not_exists(similarityHash)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={**item_values(result), ":ready": {"S": "ready"}},
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return "changed"
        raise
    return "written"


def backfill(ddb: Any, s3: Any, table: str, bucket: str, dry_run: bool = False) -> Counter[str]:
    photos = find_photos(ddb, table)
    with ThreadPoolExecutor(WORKERS) as pool:
        outcomes = pool.map(
            lambda p: backfill_one(ddb, s3, table, bucket, p[0], p[1], dry_run), photos
        )
        return Counter(outcomes)


def main() -> None:
    import boto3

    table, bucket = sys.argv[1], sys.argv[2]
    dry_run = "--dry-run" in sys.argv[3:]
    counts = backfill(boto3.client("dynamodb"), boto3.client("s3"), table, bucket, dry_run)
    total = sum(counts.values())
    details = ", ".join(f"{n} {outcome}" for outcome, n in sorted(counts.items())) or "nothing"
    print(f"{total} ready photos without a similarity hash: {details}")


if __name__ == "__main__":
    main()
