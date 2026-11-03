"""Video processing (spec §10.2, 14.3): the video side of `BaseProcessor` (`base.py`, which holds
the contract with the API and the shared `ready` transaction: Usage, places, album order).

The original is read through ranged GETs (`s3_range.py`), never downloaded whole, and probed by
PyAV (`video.py`); the poster frame becomes the same thumb and preview JPEGs as a photo's, so the
gallery and caches treat videos like photos. `ready` also sets `durationMs`, `videoCodec` and
`playable`, and both final states drop the multipart `uploadId` if `complete` didn't (14.2).
"""

from typing import ClassVar

from botocore.exceptions import ClientError

from .base import BaseProcessor, Derived, SourceFailed, SourceGone, _etag
from .derived import derive_jpegs
from .s3_range import ReadLimitExceeded, S3RangeFile
from .video import PermanentVideoError, process_video

# Mirrors MAX_VIDEO_BYTES in packages/shared/src/constants.ts (FR-VID-1).
MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024


class VideoProcessor(BaseProcessor):
    MEDIA_TYPE: ClassVar[str] = "video"
    FINAL_REMOVE: ClassVar[str] = " REMOVE uploadId"

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

        extra_set = ", videoCodec = :codec, playable = :playable"
        extra_values = {":codec": {"S": video.codec}, ":playable": {"BOOL": video.playable}}
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
