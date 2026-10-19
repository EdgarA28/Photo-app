"""Processes one uploaded original: S3 + DynamoDB side of spec §10 (tasks 6.1, 6.4, 6.5).

Contract with the API (§8.2):
- The API creates the Photo item with `status: pending` before the upload.
- This function moves it to `ready` (width, height, takenAt, GSI1SK, actual sizeBytes) or
  `failed`, and counts the stored original in the user's Usage item exactly once.
- The status condition makes it idempotent: S3 can deliver an event more than once and Lambda
  retries failed invocations, so anything not `pending` is skipped.

Errors: corrupt/unsupported images are permanent (mark `failed`, return normally). Everything
else (S3/DynamoDB/network) is transient and raised, so Lambda retries and then uses the DLQ.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

from .imaging import MAX_SOURCE_BYTES, PermanentImageError, process_image, to_iso
from .s3_keys import parse_original_key, preview_key, thumb_key

logger = logging.getLogger(__name__)

# §8.1: derived images never change for a given key.
DERIVED_CACHE_CONTROL = "public, max-age=31536000, immutable"


@dataclass(frozen=True)
class Outcome:
    status: str
    """`ready`, `failed` or `skipped`."""
    reason: str = ""


class Processor:
    def __init__(self, s3: Any, dynamodb: Any, table_name: str) -> None:
        self._s3 = s3
        self._dynamodb = dynamodb
        self._table = table_name

    def process(self, bucket: str, key: str, size: int, event_time: datetime) -> Outcome:
        parsed = parse_original_key(key)
        if parsed is None:
            # Loop protection (§10): our own thumbs/previews and anything unexpected.
            return Outcome("skipped", "not an original key")
        user_id, photo_id = parsed.user_id, parsed.photo_id
        log = {"userId": user_id, "photoId": photo_id, "key": key}

        item = self._get_photo(user_id, photo_id)
        if item is None:
            logger.warning("No photo item for original", extra=log)
            return Outcome("skipped", "no photo item")
        if item.get("status", {}).get("S") != "pending":
            return Outcome("skipped", "already processed")

        if size > MAX_SOURCE_BYTES:
            return self._fail(user_id, photo_id, size, f"source is {size} bytes", log)

        try:
            obj = self._s3.get_object(Bucket=bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                return Outcome("skipped", "original no longer exists")
            raise
        size = obj["ContentLength"]
        if size > MAX_SOURCE_BYTES:
            return self._fail(user_id, photo_id, size, f"source is {size} bytes", log)
        data = obj["Body"].read()

        try:
            image = process_image(data)
        except PermanentImageError as e:
            return self._fail(user_id, photo_id, size, str(e), log)

        thumb, preview = thumb_key(user_id, photo_id), preview_key(user_id, photo_id)
        self._put_jpeg(bucket, thumb, image.thumb)
        self._put_jpeg(bucket, preview, image.preview)

        uploaded_at = item.get("uploadedAt", {}).get("S")
        taken_at = to_iso(image.taken_at) if image.taken_at else uploaded_at or to_iso(event_time)
        updated = self._finish(
            user_id,
            photo_id,
            size,
            "SET #status = :ready, width = :w, height = :h, takenAt = :t, GSI1SK = :gsi, "
            "sizeBytes = :size, processedAt = :now",
            {
                ":ready": {"S": "ready"},
                ":w": {"N": str(image.width)},
                ":h": {"N": str(image.height)},
                ":t": {"S": taken_at},
                ":gsi": {"S": f"TAKEN#{taken_at}#{photo_id}"},
            },
        )
        if not updated:
            # Lost a race: the photo was deleted (or processed by a duplicate event) meanwhile.
            if self._get_photo(user_id, photo_id) is None:
                self._s3.delete_objects(
                    Bucket=bucket, Delete={"Objects": [{"Key": thumb}, {"Key": preview}]}
                )
            return Outcome("skipped", "photo changed during processing")

        logger.info(
            "Photo ready",
            extra={**log, "width": image.width, "height": image.height, "takenAt": taken_at},
        )
        return Outcome("ready")

    def _fail(
        self, user_id: str, photo_id: str, size: int, reason: str, log: dict[str, str]
    ) -> Outcome:
        logger.warning("Photo failed", extra={**log, "reason": reason})
        updated = self._finish(
            user_id,
            photo_id,
            size,
            "SET #status = :failed, failureReason = :reason, sizeBytes = :size, processedAt = :now",
            {":failed": {"S": "failed"}, ":reason": {"S": reason[:500]}},
        )
        return Outcome("failed", reason) if updated else Outcome("skipped", "photo changed")

    def _get_photo(self, user_id: str, photo_id: str) -> dict[str, Any] | None:
        response = self._dynamodb.get_item(
            TableName=self._table,
            Key={"PK": {"S": f"USER#{user_id}"}, "SK": {"S": f"PHOTO#{photo_id}"}},
            ConsistentRead=True,
        )
        return response.get("Item")

    def _put_jpeg(self, bucket: str, key: str, body: bytes) -> None:
        self._s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="image/jpeg",
            CacheControl=DERIVED_CACHE_CONTROL,
            StorageClass="STANDARD",
        )

    def _finish(
        self,
        user_id: str,
        photo_id: str,
        size: int,
        update_expression: str,
        values: dict[str, Any],
    ) -> bool:
        """Applies the final status and counts the original in Usage, atomically.

        Returns False if the photo is gone or no longer `pending`."""
        try:
            self._dynamodb.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {
                                "PK": {"S": f"USER#{user_id}"},
                                "SK": {"S": f"PHOTO#{photo_id}"},
                            },
                            "UpdateExpression": update_expression,
                            "ConditionExpression": "attribute_exists(PK) AND #status = :pending",
                            "ExpressionAttributeNames": {"#status": "status"},
                            "ExpressionAttributeValues": {
                                **values,
                                ":pending": {"S": "pending"},
                                ":size": {"N": str(size)},
                                ":now": {"S": to_iso(datetime.now(UTC))},
                            },
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table,
                            "Key": {"PK": {"S": f"USER#{user_id}"}, "SK": {"S": "USAGE"}},
                            "UpdateExpression": "ADD bytesUsed :size, photoCount :one",
                            "ExpressionAttributeValues": {
                                ":size": {"N": str(size)},
                                ":one": {"N": "1"},
                            },
                        }
                    },
                ]
            )
        except ClientError as e:
            reasons = e.response.get("CancellationReasons") or []
            if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons):
                return False
            raise
        return True
