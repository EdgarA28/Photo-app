"""Video processing (spec §10.2, 14.3): the video side of `BaseProcessor` (`base.py`, which holds
the contract with the API and the shared `ready` transaction: Usage, places, album order).

The original is read through ranged GETs (`s3_range.py`), never downloaded whole, and probed by
PyAV (`video.py`); the poster frame becomes the same thumb and preview JPEGs as a photo's, so the
gallery and caches treat videos like photos. `ready` also sets `durationMs`, `videoCodec` and
`playable`, and both final states drop the multipart `uploadId` if `complete` didn't (14.2).

Playback copy (14.9, B-7 V2, `transcode.py`): right after `ready`, in the same invocation, the
video is converted to `playback/{id}.mp4` (720p H.264 + AAC, faststart). The item's
`playbackStatus` goes `pending` → `ready` (with `playbackSizeBytes`) or `failed`
(`playbackReason`); videos longer than `MAX_PLAYBACK_DURATION_MS` get `skipped` and keep playing
the original. The copy is not counted in Usage (the app's own file, FR-ACC-2). A message for a
video that is already `ready` but whose copy is still `pending` or missing (a retry after a
transient error, or the backfill of videos from before 14.9) makes only the copy.
"""

import logging
import os
import tempfile
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, ClassVar

from botocore.exceptions import ClientError

from .base import (
    DERIVED_CACHE_CONTROL,
    BaseProcessor,
    Derived,
    Outcome,
    SourceFailed,
    SourceGone,
    _etag,
)
from .derived import derive_jpegs, to_iso
from .s3_keys import parse_original_key, playback_key
from .s3_range import ReadLimitExceeded, S3RangeFile
from .transcode import OutOfTime, transcode
from .video import PermanentVideoError, process_video

logger = logging.getLogger(__name__)

# Mirrors MAX_VIDEO_BYTES in packages/shared/src/constants.ts (FR-VID-1).
MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024
# Longer videos get no copy (14.9): Lambda stops after 15 min, and a copy must finish within one
# invocation. Mirrors MAX_PLAYBACK_DURATION_MS in packages/shared/src/constants.ts.
MAX_PLAYBACK_DURATION_MS = 20 * 60 * 1000
# Stop encoding with this much time left: enough to report the copy as failed (no upload).
PLAYBACK_MIN_TIME_LEFT_MS = 45_000
# FFmpeg reads the source front to back, plus the index and some back-and-forth between audio and
# video chunks; a badly interleaved file could otherwise read the same bytes many times.
PLAYBACK_READ_FACTOR = 3
PLAYBACK_READ_SLACK_BYTES = 64 * 1024 * 1024


class VideoProcessor(BaseProcessor):
    MEDIA_TYPE: ClassVar[str] = "video"
    FINAL_REMOVE: ClassVar[str] = " REMOVE uploadId"

    def __init__(self, s3: Any, dynamodb: Any, table_name: str, tmp_dir: str | None = None) -> None:
        super().__init__(s3, dynamodb, table_name)
        self._tmp_dir = tmp_dir
        self.time_left_ms: Callable[[], int] | None = None
        """The invocation's remaining time (set per invocation by the handler); None in tests."""

    def process(
        self, bucket: str, key: str, size: int, event_time: datetime, etag: str | None = None
    ) -> Outcome:
        outcome = super().process(bucket, key, size, event_time, etag)
        if outcome.status == "ready" or outcome.reason == "already processed":
            self._make_playback(bucket, key)
        return outcome

    def _derived_keys(self, user_id: str, photo_id: str) -> list[str]:
        return [*super()._derived_keys(user_id, photo_id), playback_key(user_id, photo_id)]

    def _derive(self, bucket: str, key: str, size: int, event_etag: str | None) -> Derived:
        if size > MAX_VIDEO_BYTES:
            raise SourceFailed(f"source is {size} bytes", size, event_etag)
        try:
            head = self._s3.head_object(Bucket=bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                raise SourceGone from e
            raise
        size = head["ContentLength"]
        # Every read below is pinned to these bytes (IfMatch), the ones recorded as processed.
        quoted_etag = head["ETag"]
        processed_etag = _etag(quoted_etag)
        if size > MAX_VIDEO_BYTES:
            raise SourceFailed(f"source is {size} bytes", size, processed_etag)

        source = S3RangeFile(self._s3, bucket, key, size, quoted_etag)
        try:
            video = process_video(source)
        except (PermanentVideoError, ReadLimitExceeded) as e:
            raise SourceFailed(str(e), size, processed_etag) from e
        thumb, preview = derive_jpegs(video.poster)

        too_long = (video.duration_ms or 0) > MAX_PLAYBACK_DURATION_MS
        extra_set = ", videoCodec = :codec, playable = :playable, playbackStatus = :playback"
        extra_values = {
            ":codec": {"S": video.codec},
            ":playable": {"BOOL": video.playable},
            ":playback": {"S": "skipped" if too_long else "pending"},
        }
        if video.duration_ms is not None:
            extra_set += ", durationMs = :duration"
            extra_values[":duration"] = {"N": str(video.duration_ms)}
        return Derived(
            size=size,
            etag=processed_etag,
            width=video.width,
            height=video.height,
            taken_at=video.taken_at,
            gps=video.gps,
            thumb=thumb,
            preview=preview,
            extra_set=extra_set,
            extra_values=extra_values,
            log={
                "durationMs": video.duration_ms,
                "codec": video.codec,
                "bytesRead": source.bytes_read,
                "rangeRequests": source.requests,
            },
        )

    def _make_playback(self, bucket: str, key: str) -> None:
        """Makes the playback copy of a `ready` video whose copy is `pending` or missing."""
        parsed = parse_original_key(key)
        assert parsed is not None  # `process` returned ready / already processed for it
        user_id, photo_id = parsed.user_id, parsed.photo_id
        log: dict[str, Any] = {"userId": user_id, "photoId": photo_id, "key": key}
        item = self._get_photo(user_id, photo_id)
        if item is None or item.get("status", {}).get("S") != "ready":
            return
        if item.get("playbackStatus", {}).get("S", "pending") != "pending":
            return
        stored_etag = item.get("originalETag", {}).get("S")
        if int(item.get("durationMs", {}).get("N", "0")) > MAX_PLAYBACK_DURATION_MS:
            self._set_playback(user_id, photo_id, stored_etag, "skipped", reason="too long")
            return

        try:
            head = self._s3.head_object(Bucket=bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return
            raise
        if stored_etag is not None and _etag(head["ETag"]) != stored_etag:
            return  # Replaced after processing: `_check_unchanged` fails the video.
        size = head["ContentLength"]
        source = S3RangeFile(
            self._s3,
            bucket,
            key,
            size,
            head["ETag"],
            max_bytes=size * PLAYBACK_READ_FACTOR + PLAYBACK_READ_SLACK_BYTES,
        )
        target = playback_key(user_id, photo_id)
        started = datetime.now(UTC)
        with tempfile.TemporaryDirectory(dir=self._tmp_dir) as tmp:
            path = os.path.join(tmp, "playback.mp4")
            try:
                copy = transcode(source, path, self.time_left_ms, PLAYBACK_MIN_TIME_LEFT_MS)
            except (PermanentVideoError, ReadLimitExceeded, OutOfTime) as e:
                logger.warning("Playback copy failed", extra={**log, "reason": str(e)})
                self._set_playback(user_id, photo_id, stored_etag, "failed", reason=str(e))
                return
            copy_size = os.path.getsize(path)
            # Multipart above 8 MB (boto3's transfer manager).
            self._s3.upload_file(
                path,
                bucket,
                target,
                ExtraArgs={
                    "ContentType": "video/mp4",
                    "CacheControl": DERIVED_CACHE_CONTROL,
                    "StorageClass": "STANDARD",
                },
            )
        if not self._set_playback(user_id, photo_id, stored_etag, "ready", size=copy_size):
            # Deleted meanwhile (its objects were deleted before ours existed), or replaced.
            if self._get_photo(user_id, photo_id) is None:
                self._s3.delete_object(Bucket=bucket, Key=target)
            return
        logger.info(
            "Playback copy ready",
            extra={
                **log,
                "width": copy.width,
                "height": copy.height,
                "frames": copy.frames,
                "audio": copy.has_audio,
                "sizeBytes": copy_size,
                "originalBytes": size,
                "bytesRead": source.bytes_read,
                "rangeRequests": source.requests,
                "seconds": round((datetime.now(UTC) - started).total_seconds(), 1),
            },
        )

    def _set_playback(
        self,
        user_id: str,
        photo_id: str,
        stored_etag: str | None,
        status: str,
        *,
        size: int | None = None,
        reason: str | None = None,
    ) -> bool:
        """The copy's final state, only on the same `ready` video with the same original whose
        copy is still pending. Returns False if that's no longer so."""
        expression = "SET playbackStatus = :status, playbackAt = :now"
        values: dict[str, Any] = {
            ":status": {"S": status},
            ":now": {"S": to_iso(datetime.now(UTC))},
            ":ready": {"S": "ready"},
            ":pending": {"S": "pending"},
        }
        condition = (
            "attribute_exists(PK) AND #status = :ready AND "
            "(attribute_not_exists(playbackStatus) OR playbackStatus = :pending)"
        )
        if size is not None:
            expression += ", playbackSizeBytes = :size"
            values[":size"] = {"N": str(size)}
        if reason is not None:
            expression += ", playbackReason = :reason"
            values[":reason"] = {"S": reason[:500]}
        if stored_etag is not None:
            condition += " AND originalETag = :etag"
            values[":etag"] = {"S": stored_etag}
        try:
            self._dynamodb.update_item(
                TableName=self._table,
                Key={"PK": {"S": f"USER#{user_id}"}, "SK": {"S": f"PHOTO#{photo_id}"}},
                UpdateExpression=expression,
                ConditionExpression=condition,
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues=values,
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            raise
        return True
