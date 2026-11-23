"""Backfill of similarity values (8.37c; FR-GAL-10/11/12, spec §10) against moto."""

import importlib.util
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import boto3
import pytest
from conftest import encode, two_tone
from moto import mock_aws

from thumbnails.processor import Processor
from thumbnails.s3_keys import preview_key, thumb_key

BUCKET = "photo-app-photos-test"
TABLE = "photo-app-test"
USER = "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f"
UPLOADED_AT = "2026-10-19T08:00:00.000Z"
SIMILARITY = ("similarityHash", "sharpness")


def load_script() -> ModuleType:
    path = Path(__file__).parents[1] / "scripts" / "backfill_similarity.py"
    spec = importlib.util.spec_from_file_location("backfill_similarity", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


script = load_script()


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, Any]]:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    with mock_aws():
        s3 = boto3.client("s3")
        ddb = boto3.client("dynamodb")
        s3.create_bucket(Bucket=BUCKET)
        ddb.create_table(
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
        yield s3, ddb


def key(photo_id: str) -> dict[str, Any]:
    return {"PK": {"S": f"USER#{USER}"}, "SK": {"S": f"PHOTO#{photo_id}"}}


def get(ddb: Any, photo_id: str) -> dict[str, Any]:
    return ddb.get_item(TableName=TABLE, Key=key(photo_id))["Item"]


def processed_photo(s3: Any, ddb: Any, photo_id: str, size: tuple[int, int] = (1200, 900)) -> None:
    """A photo made ready by the real Lambda code (with the 8.37a values)."""
    data = encode(two_tone(size), "JPEG")
    ddb.put_item(
        TableName=TABLE,
        Item={
            **key(photo_id),
            "status": {"S": "pending"},
            "uploadedAt": {"S": UPLOADED_AT},
            "sizeBytes": {"N": str(len(data))},
        },
    )
    original = f"users/{USER}/originals/{photo_id}.jpg"
    s3.put_object(Bucket=BUCKET, Key=original, Body=data)
    outcome = Processor(s3, ddb, TABLE).process(BUCKET, original, len(data), datetime.now(UTC))
    assert outcome.status == "ready"


def strip_similarity(ddb: Any, photo_id: str) -> None:
    """As if it was processed before 8.37a."""
    ddb.update_item(
        TableName=TABLE, Key=key(photo_id), UpdateExpression="REMOVE " + ", ".join(SIMILARITY)
    )


def put_item(ddb: Any, photo_id: str, **attrs: dict[str, Any]) -> None:
    ddb.put_item(TableName=TABLE, Item={**key(photo_id), **attrs})


PHOTO_A = "01JABCDEFGHJKMNPQRSTVWXYZ0"
PHOTO_B = "01JABCDEFGHJKMNPQRSTVWXYZ1"
PHOTO_C = "01JABCDEFGHJKMNPQRSTVWXYZ2"


def test_backfill_writes_what_the_lambda_wrote(aws: tuple[Any, Any]) -> None:
    s3, ddb = aws
    processed_photo(s3, ddb, PHOTO_A)
    live = {name: get(ddb, PHOTO_A)[name] for name in SIMILARITY}
    strip_similarity(ddb, PHOTO_A)

    counts = script.backfill(ddb, s3, TABLE, BUCKET)

    assert counts == {"written": 1}
    assert {name: get(ddb, PHOTO_A)[name] for name in SIMILARITY} == live


def test_second_run_finds_nothing_and_existing_values_stay(aws: tuple[Any, Any]) -> None:
    s3, ddb = aws
    processed_photo(s3, ddb, PHOTO_A)  # Has its values already.
    processed_photo(s3, ddb, PHOTO_B, size=(900, 1200))
    strip_similarity(ddb, PHOTO_B)
    before_a = get(ddb, PHOTO_A)

    assert script.backfill(ddb, s3, TABLE, BUCKET) == {"written": 1}
    assert script.backfill(ddb, s3, TABLE, BUCKET) == {}
    assert get(ddb, PHOTO_A) == before_a


def test_dry_run_writes_nothing(aws: tuple[Any, Any]) -> None:
    s3, ddb = aws
    processed_photo(s3, ddb, PHOTO_A)
    strip_similarity(ddb, PHOTO_A)

    assert script.backfill(ddb, s3, TABLE, BUCKET, dry_run=True) == {"would write": 1}
    assert "similarityHash" not in get(ddb, PHOTO_A)


def test_trashed_photos_are_included(aws: tuple[Any, Any]) -> None:
    """A photo restored from the trash can stack too."""
    s3, ddb = aws
    processed_photo(s3, ddb, PHOTO_A)
    strip_similarity(ddb, PHOTO_A)
    ddb.update_item(
        TableName=TABLE,
        Key=key(PHOTO_A),
        UpdateExpression="SET trashedAt = :t",
        ExpressionAttributeValues={":t": {"S": "2026-11-20T10:00:00.000Z"}},
    )

    assert script.backfill(ddb, s3, TABLE, BUCKET) == {"written": 1}
    assert "similarityHash" in get(ddb, PHOTO_A)


def test_videos_pending_failed_and_other_items_are_skipped(aws: tuple[Any, Any]) -> None:
    s3, ddb = aws
    put_item(ddb, PHOTO_A, status={"S": "ready"}, mediaType={"S": "video"})
    put_item(ddb, PHOTO_B, status={"S": "pending"})
    put_item(ddb, PHOTO_C, status={"S": "failed"})
    ddb.put_item(
        TableName=TABLE,
        Item={"PK": {"S": f"USER#{USER}"}, "SK": {"S": "USAGE"}, "status": {"S": "ready"}},
    )

    assert script.find_photos(ddb, TABLE) == []
    assert script.backfill(ddb, s3, TABLE, BUCKET) == {}


def test_missing_images_are_counted_not_fatal(aws: tuple[Any, Any]) -> None:
    s3, ddb = aws
    processed_photo(s3, ddb, PHOTO_A)
    processed_photo(s3, ddb, PHOTO_B)
    for photo_id in (PHOTO_A, PHOTO_B):
        strip_similarity(ddb, photo_id)
    s3.delete_object(Bucket=BUCKET, Key=preview_key(USER, PHOTO_A))
    s3.delete_object(Bucket=BUCKET, Key=thumb_key(USER, PHOTO_A))

    assert script.backfill(ddb, s3, TABLE, BUCKET) == {"missing images": 1, "written": 1}
    assert "similarityHash" not in get(ddb, PHOTO_A)


def test_photo_changed_meanwhile_is_not_written(aws: tuple[Any, Any]) -> None:
    """Deleted after the scan, or the Lambda wrote its values meanwhile: the condition holds."""
    s3, ddb = aws
    processed_photo(s3, ddb, PHOTO_A)
    processed_photo(s3, ddb, PHOTO_B)
    strip_similarity(ddb, PHOTO_A)
    ddb.delete_item(TableName=TABLE, Key=key(PHOTO_B))

    assert script.backfill_one(ddb, s3, TABLE, BUCKET, USER, PHOTO_B, False) == "changed"
    assert "Item" not in ddb.get_item(TableName=TABLE, Key=key(PHOTO_B))  # No stub item.
    ddb.update_item(
        TableName=TABLE,
        Key=key(PHOTO_A),
        UpdateExpression="SET similarityHash = :h",
        ExpressionAttributeValues={":h": {"S": "0" * 16}},
    )
    assert script.backfill_one(ddb, s3, TABLE, BUCKET, USER, PHOTO_A, False) == "changed"
    assert get(ddb, PHOTO_A)["similarityHash"]["S"] == "0" * 16
