"""Handler + processor against mocked S3 and DynamoDB (moto): §10, tasks 6.1, 6.4, 6.5."""

import io
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from PIL import Image

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


def put_pending(dynamodb: Any) -> None:
    dynamodb.put_item(
        TableName=TABLE,
        Item={
            **PHOTO_KEY,
            "status": {"S": "pending"},
            "uploadedAt": {"S": UPLOADED_AT},
            "GSI1PK": {"S": f"USER#{USER}"},
            "GSI1SK": {"S": f"TAKEN#{UPLOADED_AT}#{PHOTO}"},
            "sizeBytes": {"N": "1"},
        },
    )


def s3_event(key: str, size: int) -> dict[str, Any]:
    return {
        "Records": [
            {
                "eventTime": "2026-10-19T08:00:05.000Z",
                "s3": {"bucket": {"name": BUCKET}, "object": {"key": key, "size": size}},
            }
        ]
    }


def upload(s3: Any, data: bytes, key: str = ORIGINAL) -> dict[str, Any]:
    s3.put_object(Bucket=BUCKET, Key=key, Body=data)
    return s3_event(key, len(data))


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
    put_pending(dynamodb)

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

    for key, edge in ((THUMB, 400), (PREVIEW, 1600)):
        head = s3.head_object(Bucket=BUCKET, Key=key)
        assert head["ContentType"] == "image/jpeg"
        assert head["CacheControl"] == DERIVED_CACHE_CONTROL
        body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        assert max(Image.open(io.BytesIO(body)).size) == edge


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


def test_missing_item_is_skipped(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, _ = aws
    result = handler_module.handler(upload(s3, jpeg_plain))
    assert result["results"][0]["reason"] == "no photo item"
    assert not exists(s3, THUMB)


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
    assert get(dynamodb, USAGE_KEY) is None


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
