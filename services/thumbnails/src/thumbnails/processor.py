"""Photo processing (spec §10, tasks 6.1-6.5): the photo side of `BaseProcessor` (`base.py`,
which holds the contract with the API and the shared transaction). Reads the whole original
(≤ 50 MB, FR-UP-3) and makes the thumb and preview with Pillow (`imaging.py`)."""

from datetime import UTC, datetime
from typing import Any, ClassVar

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
from .similarity import SET_CLAUSE, item_values, similarity

__all__ = [
    "DERIVED_CACHE_CONTROL",
    "MAX_SOURCE_BYTES",
    "TRANSACTION_ATTEMPTS",
    "Outcome",
    "Processor",
    "conflict_pause",
]


TAKEN_AT_METADATA = "taken-at"
"""`x-amz-meta-taken-at`: Google's creation time, set by the import worker (13.5d, §10). Uploads
from the browser can't carry it (the pre-signed POST policy allows no extra fields)."""

EARLIEST_TAKEN_AT = datetime(1826, 1, 1, tzinfo=UTC)
"""Before the first photograph: such a date is a broken value, not a date taken."""


def metadata_taken_at(obj: dict[str, Any]) -> datetime | None:
    """The `taken-at` object metadata as an aware UTC datetime, or None when it is missing,
    unreadable, without a time zone, before photography or more than a day in the future (the
    caller then falls back to the upload time, §8.2)."""
    raw = (obj.get("Metadata") or {}).get(TAKEN_AT_METADATA)
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.fromisoformat(raw.strip())
    except ValueError:
        return None
    if value.tzinfo is None:
        return None
    value = value.astimezone(UTC)
    latest = datetime.now(UTC).timestamp() + 86_400
    if value < EARLIEST_TAKEN_AT or value.timestamp() > latest:
        return None
    return value


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
        # Similar photos (8.37a, FR-GAL-10/12): photos only, from the JPEGs just made.
        similar = similarity(image.thumb, image.preview)
        return Derived(
            size=size,
            etag=processed_etag,
            width=image.width,
            height=image.height,
            # EXIF first; an import from Google Photos also carries Google's date (FR-IMP-4).
            taken_at=image.taken_at or metadata_taken_at(obj),
            gps=image.gps,
            thumb=image.thumb,
            preview=image.preview,
            extra_set=", " + SET_CLAUSE,
            extra_values=item_values(similar),
            log={"similarityHash": similar.hash, "sharpness": round(similar.sharpness, 2)},
        )
