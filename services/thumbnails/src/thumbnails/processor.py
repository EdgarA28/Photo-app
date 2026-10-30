"""Processes one uploaded original: S3 + DynamoDB side of spec §10 (tasks 6.1, 6.4, 6.5).

Contract with the API (§8.2):
- The API creates the Photo item with `status: pending` before the upload.
- This function moves it to `ready` (width, height, takenAt, GSI1SK, actual sizeBytes) or
  `failed`, and counts the stored original in the user's Usage item exactly once. The API
  reserved the declared size in `bytesReserved` (task 5.6b); this moves that reservation to the
  actual size (the upload policy pins the size, so the difference is normally 0).
- The status condition makes it idempotent: S3 can deliver an event more than once and Lambda
  retries failed invocations, so anything not `pending` is skipped.
- An original without a Photo item is an orphan and gets deleted (task 6.12): the API writes the
  item before it hands out the upload POST, so a missing item means the photo was deleted, e.g.
  while its upload was still in flight (the POST stays valid for 15 min).
- The same POST can overwrite the original after processing (12.2b). The item keeps the ETag of
  the bytes that were processed (`originalETag`); when a later event finds other bytes, the photo
  becomes `failed` and loses its thumb and preview, so share recipients (who see `ready` photos
  only) can't download something other than what they were shown. Not reprocessed: derived images
  are cached as immutable under the same URL, so new ones wouldn't reach viewers.
- Album memberships are sorted by the photo's takenAt (GSI1 `ALBUM#{albumId}`, §12.3). Once the
  photo is `ready` with its real takenAt, the memberships made while it was pending (sorted by the
  provisional upload time) are moved to match. The API writes a membership with the photo's takenAt
  at that moment, conditional on it, so one added meanwhile is right already.
- Places (13.2): a photo with EXIF GPS gets the nearest town, its region and country (offline
  lookup, `places.py`), written in the same transaction as `ready`: the place on the photo, one
  item per place in the owner's place list (`USER#{userId}` / `PLACE#{placeId}`, with a photo
  count, for search) and one per place and photo, sorted by takenAt in GSI1
  (`PLACE#{userId}#{placeId}` / `PHOTO#{photoId}`). The API removes them with the photo.

Errors: corrupt/unsupported images are permanent (mark `failed`, return normally). Everything
else (S3/DynamoDB/network) is transient and raised, so Lambda retries and then uses the DLQ.
"""

import logging
import random
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

from . import places
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

    def process(
        self, bucket: str, key: str, size: int, event_time: datetime, etag: str | None = None
    ) -> Outcome:
        parsed = parse_original_key(key)
        if parsed is None:
            # Loop protection (§10): our own thumbs/previews and anything unexpected.
            return Outcome("skipped", "not an original key")
        user_id, photo_id = parsed.user_id, parsed.photo_id
        log = {"userId": user_id, "photoId": photo_id, "key": key}

        item = self._get_photo(user_id, photo_id)
        if item is None:
            # Consistent read, so the item really is gone. Nothing counts this original against
            # the quota and nobody can see or delete it, so it must not stay (6.12).
            self._s3.delete_object(Bucket=bucket, Key=key)
            logger.warning("Deleted original without a photo item", extra=log)
            return Outcome("skipped", "orphaned original deleted")
        if item.get("status", {}).get("S") != "pending":
            return self._check_unchanged(bucket, key, item, _etag(etag), log)
        declared = int(item.get("sizeBytes", {}).get("N", "0"))

        if size > MAX_SOURCE_BYTES:
            return self._fail(
                user_id, photo_id, size, declared, f"source is {size} bytes", _etag(etag), log
            )

        try:
            obj = self._s3.get_object(Bucket=bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                return Outcome("skipped", "original no longer exists")
            raise
        size = obj["ContentLength"]
        # The bytes actually read, which may already be newer than the event's (12.2b).
        processed_etag = _etag(obj.get("ETag"))
        if size > MAX_SOURCE_BYTES:
            return self._fail(
                user_id, photo_id, size, declared, f"source is {size} bytes", processed_etag, log
            )
        data = obj["Body"].read()

        try:
            image = process_image(data)
        except PermanentImageError as e:
            return self._fail(user_id, photo_id, size, declared, str(e), processed_etag, log)

        thumb, preview = thumb_key(user_id, photo_id), preview_key(user_id, photo_id)
        self._put_jpeg(bucket, thumb, image.thumb)
        self._put_jpeg(bucket, preview, image.preview)

        uploaded_at = item.get("uploadedAt", {}).get("S")
        taken_at = to_iso(image.taken_at) if image.taken_at else uploaded_at or to_iso(event_time)
        place = places.lookup(*image.gps) if image.gps else None
        place_set, place_values, place_items = self._place_writes(
            user_id, photo_id, taken_at, image.gps, place
        )
        updated = self._finish(
            user_id,
            photo_id,
            size,
            declared,
            "SET #status = :ready, width = :w, height = :h, takenAt = :t, GSI1SK = :gsi, "
            "sizeBytes = :size, processedAt = :now" + _etag_set(processed_etag) + place_set,
            {
                ":ready": {"S": "ready"},
                ":w": {"N": str(image.width)},
                ":h": {"N": str(image.height)},
                ":t": {"S": taken_at},
                ":gsi": {"S": f"TAKEN#{taken_at}#{photo_id}"},
                **_etag_value(processed_etag),
                **place_values,
            },
            place_items,
        )
        if not updated:
            # Lost a race: the photo was deleted (or processed by a duplicate event) meanwhile.
            if self._get_photo(user_id, photo_id) is None:
                self._s3.delete_objects(
                    Bucket=bucket, Delete={"Objects": [{"Key": thumb}, {"Key": preview}]}
                )
            return Outcome("skipped", "photo changed during processing")

        self._sync_memberships(user_id, photo_id)
        logger.info(
            "Photo ready",
            extra={**log, "width": image.width, "height": image.height, "takenAt": taken_at},
        )
        return Outcome("ready")

    def _fail(
        self,
        user_id: str,
        photo_id: str,
        size: int,
        declared: int,
        reason: str,
        etag: str | None,
        log: dict[str, str],
    ) -> Outcome:
        logger.warning("Photo failed", extra={**log, "reason": reason})
        updated = self._finish(
            user_id,
            photo_id,
            size,
            declared,
            "SET #status = :failed, failureReason = :reason, sizeBytes = :size, processedAt = :now"
            + _etag_set(etag),
            {":failed": {"S": "failed"}, ":reason": {"S": reason[:500]}, **_etag_value(etag)},
        )
        return Outcome("failed", reason) if updated else Outcome("skipped", "photo changed")

    def _check_unchanged(
        self,
        bucket: str,
        key: str,
        item: dict[str, Any],
        event_etag: str | None,
        log: dict[str, str],
    ) -> Outcome:
        """An event for a photo that is no longer `pending`: a duplicate or retry, or the original
        was overwritten after processing (12.2b). Photos processed before `originalETag` existed
        are skipped: their upload POSTs expired long ago."""
        stored = item.get("originalETag", {}).get("S")
        if stored is None or event_etag == stored:
            return Outcome("skipped", "already processed")
        try:
            current = _etag(self._s3.head_object(Bucket=bucket, Key=key).get("ETag"))
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return Outcome("skipped", "original no longer exists")
            raise
        if current == stored:
            # An older event; the processed bytes are still the stored ones.
            return Outcome("skipped", "already processed")

        user_id, photo_id = log["userId"], log["photoId"]
        reason = "original replaced after processing"
        try:
            # Usage is unchanged: the upload policy pins the exact size, and failed photos count.
            self._dynamodb.update_item(
                TableName=self._table,
                Key={"PK": {"S": f"USER#{user_id}"}, "SK": {"S": f"PHOTO#{photo_id}"}},
                UpdateExpression=(
                    "SET #status = :failed, failureReason = :reason, processedAt = :now"
                    + _etag_set(current)
                ),
                ConditionExpression="originalETag = :stored",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":failed": {"S": "failed"},
                    ":reason": {"S": reason},
                    ":now": {"S": to_iso(datetime.now(UTC))},
                    ":stored": {"S": stored},
                    **_etag_value(current),
                },
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return Outcome("skipped", "photo changed")
            raise
        self._s3.delete_objects(
            Bucket=bucket,
            Delete={
                "Objects": [
                    {"Key": thumb_key(user_id, photo_id)},
                    {"Key": preview_key(user_id, photo_id)},
                ]
            },
        )
        logger.warning("Original replaced after processing", extra=log)
        return Outcome("failed", reason)

    def _place_writes(
        self,
        user_id: str,
        photo_id: str,
        taken_at: str,
        gps: tuple[float, float] | None,
        place: places.Place | None,
    ) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
        """The photo item's place attributes (SET clause + values) and the place list and place
        photo items for the `ready` transaction (13.2c). GPS is kept even without a town nearby."""
        if gps is None:
            return "", {}, []
        set_clause = ", latitude = :lat, longitude = :lon"
        values: dict[str, Any] = {":lat": {"N": f"{gps[0]:.6f}"}, ":lon": {"N": f"{gps[1]:.6f}"}}
        if place is None:
            return set_clause, values, []

        # (kind, id, name, context shown under the name in search: "Bavaria, Germany")
        context = ", ".join(x for x in (place.region, place.country) if x)
        entries = [("city", f"city:{place.city_id}", place.city, context)]
        if place.region and place.region_id:
            entries.append(("region", f"region:{place.region_id}", place.region, place.country))
        entries.append(("country", f"country:{place.country_code}", place.country, ""))

        stored_place = {"city": {"S": place.city}, "country": {"S": place.country}}
        stored_place["countryCode"] = {"S": place.country_code}
        if place.region:
            stored_place["region"] = {"S": place.region}
        set_clause += ", place = :place, placeIds = :placeIds"
        values[":place"] = {"M": stored_place}
        values[":placeIds"] = {"SS": [place_id for _, place_id, _, _ in entries]}

        items: list[dict[str, Any]] = []
        for kind, place_id, name, place_context in entries:
            partition = f"PLACE#{user_id}#{place_id}"
            # An Update creates the item too, and the role only has GetItem/UpdateItem (NFR-SEC-7).
            items.append(
                {
                    "Update": {
                        "TableName": self._table,
                        "Key": {"PK": {"S": partition}, "SK": {"S": f"PHOTO#{photo_id}"}},
                        "UpdateExpression": "SET GSI1PK = :pk, GSI1SK = :sk, entity = :entity, "
                        "ownerId = :owner, placeId = :id, photoId = :photo",
                        "ExpressionAttributeValues": {
                            ":pk": {"S": partition},
                            ":sk": {"S": f"TAKEN#{taken_at}#{photo_id}"},
                            ":entity": {"S": "placePhoto"},
                            ":owner": {"S": user_id},
                            ":id": {"S": place_id},
                            ":photo": {"S": photo_id},
                        },
                    }
                }
            )
            items.append(
                {
                    "Update": {
                        "TableName": self._table,
                        "Key": {"PK": {"S": f"USER#{user_id}"}, "SK": {"S": f"PLACE#{place_id}"}},
                        "UpdateExpression": "SET entity = :entity, placeId = :id, kind = :kind, "
                        "#name = :name, context = :context ADD photoCount :one",
                        "ExpressionAttributeNames": {"#name": "name"},
                        "ExpressionAttributeValues": {
                            ":entity": {"S": "place"},
                            ":id": {"S": place_id},
                            ":kind": {"S": kind},
                            ":name": {"S": name},
                            ":context": {"S": place_context},
                            ":one": {"N": "1"},
                        },
                    }
                }
            )
        return set_clause, values, items

    def _sync_memberships(self, user_id: str, photo_id: str) -> None:
        """Re-sorts the photo's album memberships by its final takenAt (§12.3). Read after the
        status update, so an album added in between is either in `albumIds` here or was written
        with the final takenAt by the API."""
        item = self._get_photo(user_id, photo_id)
        if item is None:
            return
        taken_at = item["takenAt"]["S"]
        for album_id in item.get("albumIds", {}).get("SS", []):
            try:
                self._dynamodb.update_item(
                    TableName=self._table,
                    Key={"PK": {"S": f"ALBUM#{album_id}"}, "SK": {"S": f"PHOTO#{photo_id}"}},
                    UpdateExpression="SET GSI1PK = :pk, GSI1SK = :sk",
                    # Not for a membership removed meanwhile (no stub items).
                    ConditionExpression="attribute_exists(PK)",
                    ExpressionAttributeValues={
                        ":pk": {"S": f"ALBUM#{album_id}"},
                        ":sk": {"S": f"TAKEN#{taken_at}#{photo_id}"},
                    },
                )
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise

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
        declared: int,
        update_expression: str,
        values: dict[str, Any],
        extra_items: list[dict[str, Any]] | None = None,
    ) -> bool:
        """Applies the final status and counts the original in Usage, atomically: `size` is the
        stored size, `declared` the size the API reserved when it created the item.

        Returns False if the photo is gone or no longer `pending`.

        Parallel uploads all update Usage, so DynamoDB can cancel this for clashing with another
        transaction (`TransactionConflict`): retried here at once, since Lambda's own retry comes
        a minute later and the photo showed as "processing" that long (dev, 2026-10-28)."""
        for attempt in range(5):
            try:
                return self._finish_once(
                    update_expression, user_id, photo_id, size, declared, values, extra_items
                )
            except ClientError as e:
                codes = {r.get("Code") for r in e.response.get("CancellationReasons") or []}
                if attempt == 4 or "TransactionConflict" not in codes:
                    raise
                time.sleep(random.uniform(0, 0.1 * 2**attempt))
        raise AssertionError("unreachable")

    def _finish_once(
        self,
        update_expression: str,
        user_id: str,
        photo_id: str,
        size: int,
        declared: int,
        values: dict[str, Any],
        extra_items: list[dict[str, Any]] | None,
    ) -> bool:
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
                            "UpdateExpression": (
                                "ADD bytesUsed :size, photoCount :one, bytesReserved :delta"
                            ),
                            "ExpressionAttributeValues": {
                                ":size": {"N": str(size)},
                                ":one": {"N": "1"},
                                ":delta": {"N": str(size - declared)},
                            },
                        }
                    },
                    *(extra_items or []),
                ]
            )
        except ClientError as e:
            reasons = e.response.get("CancellationReasons") or []
            if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons):
                return False
            raise
        return True


def _etag(value: str | None) -> str | None:
    """ETags without quotes: S3 events send them bare, GetObject/HeadObject quoted."""
    return value.strip('"') if value else None


def _etag_set(etag: str | None) -> str:
    return ", originalETag = :etag" if etag else ""


def _etag_value(etag: str | None) -> dict[str, Any]:
    return {":etag": {"S": etag}} if etag else {}
