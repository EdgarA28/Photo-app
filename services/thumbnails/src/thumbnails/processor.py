"""Photo processing (spec §10, tasks 6.1-6.5): the photo side of `BaseProcessor` (`base.py`,
which holds the contract with the API and the shared transaction). Reads the whole original
(≤ 50 MB, FR-UP-3) and makes the thumb and preview with Pillow (`imaging.py`)."""

from typing import ClassVar

from botocore.exceptions import ClientError

from .base import (
    DERIVED_CACHE_CONTROL,
    TRANSACTION_ATTEMPTS,
    BaseProcessor,
    Derived,
    Outcome,
    SourceFailed,
    SourceGone,
    _etag,
    conflict_pause,
)
from .imaging import MAX_SOURCE_BYTES, PermanentImageError, process_image

__all__ = [
    "DERIVED_CACHE_CONTROL",
    "MAX_SOURCE_BYTES",
    "TRANSACTION_ATTEMPTS",
    "Outcome",
    "Processor",
    "conflict_pause",
]


class Processor(BaseProcessor):
    MEDIA_TYPE: ClassVar[str] = "photo"

    def _derive(self, bucket: str, key: str, size: int, event_etag: str | None) -> Derived:
        if size > MAX_SOURCE_BYTES:
            raise SourceFailed(f"source is {size} bytes", size, event_etag)
        try:
            obj = self._s3.get_object(Bucket=bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchKey":
                raise SourceGone from e
            raise
        size = obj["ContentLength"]
        # The bytes actually read, which may already be newer than the event's (12.2b).
        processed_etag = _etag(obj.get("ETag"))
        if size > MAX_SOURCE_BYTES:
            raise SourceFailed(f"source is {size} bytes", size, processed_etag)
        data = obj["Body"].read()

        try:
            image = process_image(data)
        except PermanentImageError as e:
            raise SourceFailed(str(e), size, processed_etag) from e
        return Derived(
            size=size,
            etag=processed_etag,
            width=image.width,
            height=image.height,
            taken_at=image.taken_at,
            gps=image.gps,
            thumb=image.thumb,
            preview=image.preview,
        )
