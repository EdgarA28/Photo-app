"""Handler + processor against mocked S3 and DynamoDB (moto): §10, tasks 6.1, 6.4, 6.5."""

import io
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from conftest import encode, make_exif, two_tone
from moto import mock_aws
from PIL import ExifTags, Image

from thumbnails import handler as handler_module
from thumbnails.processor import DERIVED_CACHE_CONTROL, Processor

BUCKET = "photo-app-photos-test"
TABLE = "photo-app-test"
USER = "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f"
PHOTO = "01JABCDEFGHJKMNPQRSTVWXYZ0"
UPLOADED_AT = "2026-10-19T08:00:00.000Z"
ORIGINAL = f"users/{USER}/originals/{PHOTO}.jpg"
THUMB = f"users/{USER}/thumbs/{PHOTO}.jpg"
PREVIEW = f"users/{USER}/previews/{PHOTO}.jpg"
PHOTO_KEY = {"PK": {"S": f"USER#{USER}"}, "SK": {"S": f"PHOTO#{PHOTO}"}}
USAGE_KEY = {"PK": {"S": f"USER#{USER}"}, "SK": {"S": "USAGE"}}


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, Any]]:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("TABLE_NAME", TABLE)
    with mock_aws():
        s3 = boto3.client("s3")
        dynamodb = boto3.client("dynamodb")
        s3.create_bucket(Bucket=BUCKET)
        dynamodb.create_table(
            TableName=TABLE,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
        )
        handler_module._processor.cache_clear()
        yield s3, dynamodb
        handler_module._processor.cache_clear()


def put_pending(dynamodb: Any, declared: int = 1) -> None:
    """What the API's createPending does: the item plus a reservation of its declared size."""
    dynamodb.put_item(
        TableName=TABLE,
        Item={
            **PHOTO_KEY,
            "status": {"S": "pending"},
            "uploadedAt": {"S": UPLOADED_AT},
            "GSI1PK": {"S": f"USER#{USER}"},
            "GSI1SK": {"S": f"TAKEN#{UPLOADED_AT}#{PHOTO}"},
            "sizeBytes": {"N": str(declared)},
        },
    )
    dynamodb.put_item(TableName=TABLE, Item={**USAGE_KEY, "bytesReserved": {"N": str(declared)}})


def s3_event(key: str, size: int, etag: str | None = None) -> dict[str, Any]:
    obj: dict[str, Any] = {"key": key, "size": size}
    if etag is not None:
        obj["eTag"] = etag  # Events carry it without quotes.
    return {
        "Records": [
            {
                "eventTime": "2026-10-19T08:00:05.000Z",
                "s3": {"bucket": {"name": BUCKET}, "object": obj},
            }
        ]
    }


def upload(s3: Any, data: bytes, key: str = ORIGINAL) -> dict[str, Any]:
    etag = s3.put_object(Bucket=BUCKET, Key=key, Body=data)["ETag"].strip('"')
    return s3_event(key, len(data), etag)


def get(dynamodb: Any, key: dict[str, Any]) -> dict[str, Any] | None:
    return dynamodb.get_item(TableName=TABLE, Key=key).get("Item")


def exists(s3: Any, key: str) -> bool:
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
    except ClientError:
        return False
    return True


def test_ready(aws: tuple[Any, Any], jpeg_rotated: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_rotated))

    result = handler_module.handler(upload(s3, jpeg_rotated))

    assert result["results"][0]["status"] == "ready"
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    assert item["status"]["S"] == "ready"
    assert (item["width"]["N"], item["height"]["N"]) == ("2000", "3000")
    assert item["takenAt"]["S"] == "2024-05-01T12:30:15.123Z"
    assert item["GSI1SK"]["S"] == f"TAKEN#2024-05-01T12:30:15.123Z#{PHOTO}"
    assert item["sizeBytes"]["N"] == str(len(jpeg_rotated))

    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["bytesUsed"]["N"] == str(len(jpeg_rotated))
    assert usage["photoCount"]["N"] == "1"
    # Declared = actual (the upload policy pins the size): the reservation is unchanged.
    assert usage["bytesReserved"]["N"] == str(len(jpeg_rotated))

    for key, edge in ((THUMB, 400), (PREVIEW, 1600)):
        head = s3.head_object(Bucket=BUCKET, Key=key)
        assert head["ContentType"] == "image/jpeg"
        assert head["CacheControl"] == DERIVED_CACHE_CONTROL
        body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        assert max(Image.open(io.BytesIO(body)).size) == edge


def test_reservation_moves_to_the_actual_size(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    # Task 5.6b: bytesReserved must end up equal to bytesUsed once nothing is pending.
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_plain) + 500)
    handler_module.handler(upload(s3, jpeg_plain))
    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["bytesUsed"]["N"] == usage["bytesReserved"]["N"] == str(len(jpeg_plain))


def test_taken_at_falls_back_to_upload_time(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb)
    handler_module.handler(upload(s3, jpeg_plain))
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    assert item["takenAt"]["S"] == UPLOADED_AT
    assert item["GSI1SK"]["S"] == f"TAKEN#{UPLOADED_AT}#{PHOTO}"


def test_duplicate_event_is_idempotent(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb)
    event = upload(s3, jpeg_plain)

    handler_module.handler(event)
    second = handler_module.handler(event)

    assert second["results"][0] == {
        "key": ORIGINAL,
        "status": "skipped",
        "reason": "already processed",
    }
    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["photoCount"]["N"] == "1"
    assert usage["bytesReserved"]["N"] == usage["bytesUsed"]["N"]  # Moved once, not twice.


def test_corrupt_marks_failed_without_raising(aws: tuple[Any, Any], corrupt: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb)

    result = handler_module.handler(upload(s3, corrupt))

    assert result["results"][0]["status"] == "failed"
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    assert item["status"]["S"] == "failed"
    assert item["failureReason"]["S"]
    assert item["GSI1SK"]["S"] == f"TAKEN#{UPLOADED_AT}#{PHOTO}"  # Still listed (FR-GAL-5).
    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["bytesUsed"]["N"] == str(len(corrupt))  # The original is still stored.
    assert usage["bytesReserved"]["N"] == str(len(corrupt))
    assert not exists(s3, THUMB)
    assert not exists(s3, PREVIEW)


def test_oversized_event_fails_without_download(
    aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, dynamodb = aws
    put_pending(dynamodb)
    monkeypatch.setattr("thumbnails.processor.MAX_SOURCE_BYTES", 10)

    # The object doesn't even exist: the size check happens before any S3 read.
    result = handler_module.handler(s3_event(ORIGINAL, 11))

    assert result["results"][0]["status"] == "failed"


@pytest.mark.parametrize("key", [THUMB, PREVIEW, f"users/{USER}/originals/evil.jpg", "other"])
def test_non_original_keys_are_ignored(aws: tuple[Any, Any], key: str) -> None:
    # Loop protection (§10): our own outputs must never be processed again.
    result = handler_module.handler(s3_event(key, 100))
    assert result["results"][0]["status"] == "skipped"
    assert result["results"][0]["reason"] == "not an original key"


def test_url_encoded_key_is_decoded(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb)
    s3.put_object(Bucket=BUCKET, Key=ORIGINAL, Body=jpeg_plain)
    event = s3_event(ORIGINAL.replace("/", "%2F"), len(jpeg_plain))
    assert handler_module.handler(event)["results"][0]["status"] == "ready"


def test_original_without_item_is_deleted(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    # Task 6.12: e.g. a pending photo deleted (5.9) while its upload POST was still valid.
    s3, dynamodb = aws
    result = handler_module.handler(upload(s3, jpeg_plain))
    assert result["results"][0] == {
        "key": ORIGINAL,
        "status": "skipped",
        "reason": "orphaned original deleted",
    }
    assert not exists(s3, ORIGINAL)
    assert not exists(s3, THUMB)
    assert not exists(s3, PREVIEW)
    # Nothing was counted: there is no Usage item to adjust.
    assert "Item" not in dynamodb.get_item(TableName=TABLE, Key=USAGE_KEY)


def test_orphan_cleanup_is_idempotent(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    # S3 delivers events at least once: a second event for the deleted key must not fail.
    s3, _ = aws
    event = upload(s3, jpeg_plain)
    handler_module.handler(event)
    assert handler_module.handler(event)["results"][0]["reason"] == "orphaned original deleted"


def test_original_of_another_user_is_not_touched(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    # Only the event's own key is deleted, never anything derived from other users' items.
    s3, dynamodb = aws
    put_pending(dynamodb)
    other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    orphan = f"users/{other}/originals/{PHOTO}.jpg"
    s3.put_object(Bucket=BUCKET, Key=orphan, Body=jpeg_plain)
    s3.put_object(Bucket=BUCKET, Key=ORIGINAL, Body=jpeg_plain)

    handler_module.handler(s3_event(orphan, len(jpeg_plain)))
    assert not exists(s3, orphan)
    assert exists(s3, ORIGINAL)


def test_missing_original_is_skipped(aws: tuple[Any, Any]) -> None:
    _, dynamodb = aws
    put_pending(dynamodb)
    result = handler_module.handler(s3_event(ORIGINAL, 100))
    assert result["results"][0]["reason"] == "original no longer exists"


def test_photo_deleted_during_processing_cleans_up(
    aws: tuple[Any, Any], jpeg_plain: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb)
    event = upload(s3, jpeg_plain)

    original_put = Processor._put_jpeg

    def put_then_delete_item(self: Processor, bucket: str, key: str, body: bytes) -> None:
        original_put(self, bucket, key, body)
        if key == PREVIEW:  # Simulates DELETE /photos/{id} racing with processing.
            dynamodb.delete_item(TableName=TABLE, Key=PHOTO_KEY)

    monkeypatch.setattr(Processor, "_put_jpeg", put_then_delete_item)

    result = handler_module.handler(event)

    assert result["results"][0]["status"] == "skipped"
    assert not exists(s3, THUMB)
    assert not exists(s3, PREVIEW)
    # Nothing counted; releasing the reservation is the API delete's job.
    assert get(dynamodb, USAGE_KEY) == {**USAGE_KEY, "bytesReserved": {"N": "1"}}


def test_transient_errors_are_raised(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    # NFR-OPS-1: raising makes Lambda retry and then send the event to the DLQ.
    s3, dynamodb = aws
    put_pending(dynamodb)
    event = upload(s3, jpeg_plain)
    event["Records"][0]["s3"]["bucket"]["name"] = "no-such-bucket"
    with pytest.raises(ClientError):
        handler_module.handler(event)
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    assert item["status"]["S"] == "pending"


# 12.2b: the upload POST stays valid for 15 min, so the original can be overwritten after it was
# processed. The photo must not stay `ready` with derived images of other bytes.


def same_size_variant(data: bytes) -> bytes:
    """Other bytes of the same length (the upload policy pins the exact size), still a decodable
    JPEG: one bit flipped in the middle of the image data."""
    middle = len(data) // 2
    return data[:middle] + bytes([data[middle] ^ 0x01]) + data[middle + 1 :]


def test_ready_stores_the_processed_etag(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_plain))
    handler_module.handler(upload(s3, jpeg_plain))
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    head = s3.head_object(Bucket=BUCKET, Key=ORIGINAL)
    assert item["originalETag"]["S"] == head["ETag"].strip('"')


def test_original_replaced_after_processing_fails_the_photo(
    aws: tuple[Any, Any], jpeg_plain: bytes
) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_plain))
    handler_module.handler(upload(s3, jpeg_plain))
    usage_before = get(dynamodb, USAGE_KEY)

    result = handler_module.handler(upload(s3, same_size_variant(jpeg_plain)))

    assert result["results"][0] == {
        "key": ORIGINAL,
        "status": "failed",
        "reason": "original replaced after processing",
    }
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    assert item["status"]["S"] == "failed"
    assert item["failureReason"]["S"] == "original replaced after processing"
    current = s3.head_object(Bucket=BUCKET, Key=ORIGINAL)["ETag"].strip('"')
    assert item["originalETag"]["S"] == current
    assert not exists(s3, THUMB) and not exists(s3, PREVIEW)
    # Same size, and failed photos count too: Usage doesn't move.
    assert get(dynamodb, USAGE_KEY) == usage_before

    # Its own duplicate event changes nothing more.
    again = handler_module.handler(s3_event(ORIGINAL, len(jpeg_plain), current))
    assert again["results"][0]["status"] == "skipped"


def test_duplicate_event_with_etag_is_skipped(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_plain))
    event = upload(s3, jpeg_plain)
    handler_module.handler(event)
    assert handler_module.handler(event)["results"][0]["reason"] == "already processed"
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None and item["status"]["S"] == "ready"
    assert exists(s3, THUMB)


def test_older_event_after_processing_newer_bytes_is_skipped(
    aws: tuple[Any, Any], jpeg_plain: bytes
) -> None:
    # Overwritten before the first event was handled: processing read the newer bytes, so the
    # first event arriving afterwards is stale, not a replacement.
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_plain))
    first = upload(s3, jpeg_plain)
    second = upload(s3, same_size_variant(jpeg_plain))
    assert handler_module.handler(first)["results"][0]["status"] == "ready"

    assert handler_module.handler(second)["results"][0]["reason"] == "already processed"
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None and item["status"]["S"] == "ready"
    assert exists(s3, THUMB)


def test_photos_without_stored_etag_are_skipped(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    # Processed before 12.2b: no ETag to compare with, and their upload POSTs expired long ago.
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_plain))
    handler_module.handler(upload(s3, jpeg_plain))
    dynamodb.update_item(TableName=TABLE, Key=PHOTO_KEY, UpdateExpression="REMOVE originalETag")

    result = handler_module.handler(upload(s3, same_size_variant(jpeg_plain)))

    assert result["results"][0]["reason"] == "already processed"
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None and item["status"]["S"] == "ready"


# §12.3: album memberships are sorted by the photo's takenAt (GSI1 `ALBUM#{albumId}`).


def put_membership(dynamodb: Any, album_id: str, sort_key: str) -> None:
    """What the API writes when a still-pending photo is added to an album."""
    dynamodb.put_item(
        TableName=TABLE,
        Item={
            "PK": {"S": f"ALBUM#{album_id}"},
            "SK": {"S": f"PHOTO#{PHOTO}"},
            "GSI1PK": {"S": f"ALBUM#{album_id}"},
            "GSI1SK": {"S": sort_key},
            "albumId": {"S": album_id},
            "photoId": {"S": PHOTO},
            "ownerId": {"S": USER},
        },
    )


def test_ready_moves_album_memberships_to_the_real_date(
    aws: tuple[Any, Any], jpeg_rotated: bytes
) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_rotated))
    albums = ["01JALBUMAAAAAAAAAAAAAAAAAA", "01JALBUMBBBBBBBBBBBBBBBBBB"]
    dynamodb.update_item(
        TableName=TABLE,
        Key=PHOTO_KEY,
        UpdateExpression="ADD albumIds :a",
        ExpressionAttributeValues={":a": {"SS": albums}},
    )
    provisional = f"TAKEN#{UPLOADED_AT}#{PHOTO}"
    put_membership(dynamodb, albums[0], provisional)
    put_membership(dynamodb, albums[1], provisional)

    handler_module.handler(upload(s3, jpeg_rotated))

    for album_id in albums:
        item = get(dynamodb, {"PK": {"S": f"ALBUM#{album_id}"}, "SK": {"S": f"PHOTO#{PHOTO}"}})
        assert item is not None
        assert item["GSI1SK"]["S"] == f"TAKEN#2024-05-01T12:30:15.123Z#{PHOTO}"
        assert item["GSI1PK"]["S"] == f"ALBUM#{album_id}"


def test_membership_removed_meanwhile_is_not_recreated(
    aws: tuple[Any, Any], jpeg_rotated: bytes
) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_rotated))
    dynamodb.update_item(
        TableName=TABLE,
        Key=PHOTO_KEY,
        UpdateExpression="ADD albumIds :a",
        ExpressionAttributeValues={":a": {"SS": ["01JALBUMGONEGONEGONEGONEGO"]}},
    )

    assert handler_module.handler(upload(s3, jpeg_rotated))["results"][0]["status"] == "ready"

    gone = {"PK": {"S": "ALBUM#01JALBUMGONEGONEGONEGONEGO"}, "SK": {"S": f"PHOTO#{PHOTO}"}}
    assert get(dynamodb, gone) is None


# 13.2: places from EXIF GPS, written with `ready` (jpeg_rotated was taken in central Berlin).

BERLIN = ["city:2950159", "region:DE.16", "country:DE"]


def place_item(dynamodb: Any, place_id: str) -> dict[str, Any] | None:
    return get(dynamodb, {"PK": {"S": f"USER#{USER}"}, "SK": {"S": f"PLACE#{place_id}"}})


def place_photo(dynamodb: Any, place_id: str, photo_id: str = PHOTO) -> dict[str, Any] | None:
    key = {"PK": {"S": f"PLACE#{USER}#{place_id}"}, "SK": {"S": f"PHOTO#{photo_id}"}}
    return get(dynamodb, key)


def test_ready_stores_the_place_and_lists_it(aws: tuple[Any, Any], jpeg_rotated: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_rotated))
    handler_module.handler(upload(s3, jpeg_rotated))

    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    assert (float(item["latitude"]["N"]), float(item["longitude"]["N"])) == (52.52, 13.41)
    assert item["place"]["M"] == {
        "city": {"S": "Berlin"},
        "region": {"S": "State of Berlin"},
        "country": {"S": "Germany"},
        "countryCode": {"S": "DE"},
    }
    assert sorted(item["placeIds"]["SS"]) == sorted(BERLIN)

    city = place_item(dynamodb, BERLIN[0])
    assert city is not None
    assert {k: next(iter(v.values())) for k, v in city.items() if k not in ("PK", "SK")} == {
        "entity": "place",
        "placeId": "city:2950159",
        "kind": "city",
        "name": "Berlin",
        "context": "State of Berlin, Germany",
        "photoCount": "1",
    }
    region, country = place_item(dynamodb, BERLIN[1]), place_item(dynamodb, BERLIN[2])
    assert region is not None and region["context"]["S"] == "Germany"
    assert country is not None and (country["name"]["S"], country["context"]["S"]) == (
        "Germany",
        "",
    )

    for place_id in BERLIN:
        member = place_photo(dynamodb, place_id)
        assert member is not None
        assert member["GSI1PK"]["S"] == f"PLACE#{USER}#{place_id}"
        assert member["GSI1SK"]["S"] == f"TAKEN#2024-05-01T12:30:15.123Z#{PHOTO}"
        assert member["ownerId"]["S"] == USER


def test_place_counts_add_up(aws: tuple[Any, Any], jpeg_rotated: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_rotated))
    handler_module.handler(upload(s3, jpeg_rotated))
    other = "01JABCDEFGHJKMNPQRSTVWXYZ1"
    dynamodb.put_item(
        TableName=TABLE,
        Item={
            "PK": {"S": f"USER#{USER}"},
            "SK": {"S": f"PHOTO#{other}"},
            "status": {"S": "pending"},
            "uploadedAt": {"S": UPLOADED_AT},
            "sizeBytes": {"N": str(len(jpeg_rotated))},
        },
    )
    handler_module.handler(upload(s3, jpeg_rotated, f"users/{USER}/originals/{other}.jpg"))

    for place_id in BERLIN:
        item = place_item(dynamodb, place_id)
        assert item is not None and item["photoCount"]["N"] == "2"
        assert place_photo(dynamodb, place_id, other) is not None


def test_no_gps_no_place(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, dynamodb = aws
    put_pending(dynamodb, declared=len(jpeg_plain))
    handler_module.handler(upload(s3, jpeg_plain))
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None and item["status"]["S"] == "ready"
    assert not {"latitude", "place", "placeIds"} & item.keys()
    assert place_item(dynamodb, BERLIN[0]) is None


def test_gps_far_from_any_town_keeps_coordinates_only(aws: tuple[Any, Any]) -> None:
    s3, dynamodb = aws
    exif = make_exif(taken="2024:01:01 00:00:00", gps=True)
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps[ExifTags.GPS.GPSLatitude] = (30.0, 0.0, 0.0)  # mid Atlantic
    gps[ExifTags.GPS.GPSLongitudeRef] = "W"
    gps[ExifTags.GPS.GPSLongitude] = (40.0, 0.0, 0.0)
    data = encode(two_tone((200, 100)), "JPEG", exif=exif)
    put_pending(dynamodb, declared=len(data))

    assert handler_module.handler(upload(s3, data))["results"][0]["status"] == "ready"
    item = get(dynamodb, PHOTO_KEY)
    assert item is not None
    assert (float(item["latitude"]["N"]), float(item["longitude"]["N"])) == (30.0, -40.0)
    assert not {"place", "placeIds"} & item.keys()
