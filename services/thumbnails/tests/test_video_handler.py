"""Video Lambda (14.3, spec §10.2) end to end on moto: S3 event / SQS message → ranged reads of the
original → poster thumb + preview → the `ready` transaction with the video attributes."""

import io
import json
import os
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from conftest import make_video
from moto import mock_aws
from PIL import Image

from thumbnails import video_handler, video_processor
from thumbnails.base import DERIVED_CACHE_CONTROL
from thumbnails.s3_range import ReadLimitExceeded, S3RangeFile

BUCKET = "photo-app-photos-test"
TABLE = "photo-app-test"
USER = "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f"
VIDEO = "01JABCDEFGHJKMNPQRSTVWXYZ0"
UPLOADED_AT = "2026-10-19T08:00:00.000Z"
ORIGINAL = f"users/{USER}/originals/{VIDEO}.mov"
THUMB = f"users/{USER}/thumbs/{VIDEO}.jpg"
PREVIEW = f"users/{USER}/previews/{VIDEO}.jpg"
PLAYBACK = f"users/{USER}/playback/{VIDEO}.mp4"
ITEM_KEY = {"PK": {"S": f"USER#{USER}"}, "SK": {"S": f"PHOTO#{VIDEO}"}}
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
        video_handler._processor.cache_clear()
        yield s3, dynamodb
        video_handler._processor.cache_clear()


def put_pending_video(dynamodb: Any, declared: int, upload_id: str | None = None) -> None:
    """What `POST /videos/uploads` writes (14.2): a pending video item plus its reservation."""
    item = {
        **ITEM_KEY,
        "status": {"S": "pending"},
        "mediaType": {"S": "video"},
        "contentType": {"S": "video/quicktime"},
        "uploadedAt": {"S": UPLOADED_AT},
        "GSI1PK": {"S": f"USER#{USER}"},
        "GSI1SK": {"S": f"TAKEN#{UPLOADED_AT}#{VIDEO}"},
        "sizeBytes": {"N": str(declared)},
    }
    if upload_id:
        item["uploadId"] = {"S": upload_id}
    dynamodb.put_item(TableName=TABLE, Item=item)
    dynamodb.put_item(TableName=TABLE, Item={**USAGE_KEY, "bytesReserved": {"N": str(declared)}})


def upload(s3: Any, data: bytes, key: str = ORIGINAL) -> dict[str, Any]:
    etag = s3.put_object(Bucket=BUCKET, Key=key, Body=data)["ETag"].strip('"')
    return {
        "Records": [
            {
                "eventTime": "2026-10-19T08:00:05.000Z",
                "s3": {
                    "bucket": {"name": BUCKET},
                    "object": {"key": key, "size": len(data), "eTag": etag},
                },
            }
        ]
    }


def as_sqs(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "Records": [
            {
                "messageId": "msg-0",
                "receiptHandle": "handle-0",
                "body": json.dumps(event),
                "attributes": {"ApproximateReceiveCount": "1"},
                "eventSource": "aws:sqs",
                "eventSourceARN": "arn:aws:sqs:us-east-1:123456789012:photo-app-test-videos",
            }
        ]
    }


def get(dynamodb: Any, key: dict[str, Any]) -> dict[str, Any] | None:
    return dynamodb.get_item(TableName=TABLE, Key=key).get("Item")


def exists(s3: Any, key: str) -> bool:
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
    except ClientError:
        return False
    return True


def test_ready_iphone_like_video(aws: tuple[Any, Any], mov_hevc_portrait: bytes) -> None:
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mov_hevc_portrait), upload_id="left-over")

    result = video_handler.handler(upload(s3, mov_hevc_portrait))

    assert result["results"][0]["status"] == "ready"
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["status"]["S"] == "ready"
    assert (item["width"]["N"], item["height"]["N"]) == ("240", "320")
    assert item["durationMs"]["N"] == "2000"
    assert item["videoCodec"]["S"] == "hevc"
    assert item["playable"]["BOOL"] is False
    assert item["mediaType"]["S"] == "video"
    # The recording date (FR-VID-4) sorts it in the gallery.
    assert item["takenAt"]["S"] == "2024-05-01T12:30:15.000Z"
    assert item["GSI1SK"]["S"] == f"TAKEN#2024-05-01T12:30:15.000Z#{VIDEO}"
    # Its multipart upload is over either way (14.2).
    assert "uploadId" not in item
    # Paris, from the QuickTime location tag (13.2).
    assert item["place"]["M"]["city"]["S"] == "Paris"
    assert "city:2988507" in item["placeIds"]["SS"]

    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["bytesUsed"]["N"] == str(len(mov_hevc_portrait))
    assert usage["photoCount"]["N"] == "1"
    assert usage["bytesReserved"]["N"] == str(len(mov_hevc_portrait))

    for key, edge in ((THUMB, 400), (PREVIEW, 320)):
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        assert obj["ContentType"] == "image/jpeg"
        assert obj["CacheControl"] == DERIVED_CACHE_CONTROL
        image = Image.open(io.BytesIO(obj["Body"].read()))
        assert image.format == "JPEG"
        assert max(image.size) == min(edge, 320)
        assert image.height > image.width  # portrait poster
        assert not image.getexif()


def test_ready_h264_mp4_from_the_queue(aws: tuple[Any, Any], mp4_h264: bytes) -> None:
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mp4_h264))
    key = ORIGINAL.replace(".mov", ".mp4")

    result = video_handler.handler(as_sqs(upload(s3, mp4_h264, key)))

    assert result == {"batchItemFailures": []}
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["status"]["S"] == "ready"
    assert (item["videoCodec"]["S"], item["playable"]["BOOL"]) == ("h264", True)
    assert item["takenAt"]["S"] == "2023-12-24T18:00:00.000Z"
    assert item["place"]["M"]["city"]["S"] == "Berlin"


def test_without_metadata_the_upload_time_is_used(aws: tuple[Any, Any]) -> None:
    s3, dynamodb = aws
    data = make_video(fmt="mov")
    put_pending_video(dynamodb, declared=len(data))
    video_handler.handler(upload(s3, data))
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["takenAt"]["S"] == UPLOADED_AT
    assert "place" not in item


def test_broken_video_fails_and_counts(aws: tuple[Any, Any], mp4_h264: bytes) -> None:
    s3, dynamodb = aws
    broken = mp4_h264[: len(mp4_h264) // 2]
    put_pending_video(dynamodb, declared=len(broken), upload_id="left-over")

    result = video_handler.handler(upload(s3, broken))

    assert result["results"][0]["status"] == "failed"
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["status"]["S"] == "failed"
    assert "uploadId" not in item
    assert not exists(s3, THUMB)
    # The original is stored either way, so it counts (§8.2).
    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["bytesUsed"]["N"] == str(len(broken))


def test_too_big_by_the_event_fails_without_reading(aws: tuple[Any, Any]) -> None:
    _, dynamodb = aws
    put_pending_video(dynamodb, declared=1)
    event = {
        "Records": [
            {
                "s3": {
                    "bucket": {"name": BUCKET},
                    "object": {"key": ORIGINAL, "size": 2 * 1024**3 + 1},
                }
            }
        ]
    }
    # The object doesn't even exist: the size check comes before any S3 call.
    assert video_handler.handler(event)["results"][0]["status"] == "failed"


def test_photos_are_left_to_the_thumbnail_service(aws: tuple[Any, Any], jpeg_plain: bytes) -> None:
    s3, _ = aws
    key = ORIGINAL.replace(".mov", ".jpg")
    result = video_handler.handler(upload(s3, jpeg_plain, key))
    assert result["results"][0] == {
        "key": key,
        "status": "skipped",
        "reason": "not a video original",
    }
    assert exists(s3, key)  # not deleted as an orphan


def test_orphaned_video_is_deleted(aws: tuple[Any, Any], mp4_h264: bytes) -> None:
    # 6.12: e.g. cancelled while `complete` ran (14.2): nothing counts the original.
    s3, _ = aws
    result = video_handler.handler(upload(s3, mp4_h264))
    assert result["results"][0]["reason"] == "orphaned original deleted"
    assert not exists(s3, ORIGINAL)


def test_duplicate_event_after_ready_is_skipped(aws: tuple[Any, Any], mp4_h264: bytes) -> None:
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mp4_h264))
    event = upload(s3, mp4_h264)
    video_handler.handler(event)
    assert video_handler.handler(event)["results"][0]["reason"] == "already processed"
    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["photoCount"]["N"] == "1"


def test_s3_errors_are_retried_not_failed(
    aws: tuple[Any, Any], mp4_h264: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mp4_h264))
    event = as_sqs(upload(s3, mp4_h264))
    processor = video_handler._processor()

    def down(**_kwargs: Any) -> Any:
        raise ClientError({"Error": {"Code": "SlowDown", "Message": "slow down"}}, "GetObject")

    monkeypatch.setattr(processor._s3, "get_object", down)
    assert video_handler.handler(event) == {"batchItemFailures": [{"itemIdentifier": "msg-0"}]}
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["status"]["S"] == "pending"


def test_a_big_video_is_not_downloaded(
    aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The index at the end and 64 MB of frames: only the index and the first frames are read."""
    import av

    out = io.BytesIO()
    with av.open(out, mode="w", format="mov") as container:
        stream = container.add_stream(
            "libx264", rate=30, options={"preset": "ultrafast", "qp": "0"}
        )
        stream.width, stream.height = 640, 360
        stream.pix_fmt = "yuv420p"
        for i in range(150):
            noise = Image.frombytes("RGB", (640, 360), os.urandom(640 * 360 * 3))
            frame = av.VideoFrame.from_image(noise)
            frame.pts = i
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    data = out.getvalue()
    assert len(data) > 50 * 1024**2
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(data))

    original_init = S3RangeFile.__init__

    def tracking_init(self: S3RangeFile, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        tracked.append(self)

    tracked: list[S3RangeFile] = []
    monkeypatch.setattr(S3RangeFile, "__init__", tracking_init)

    # No copy here: this test is about the poster's reads (the copy reads everything, 14.9).
    monkeypatch.setattr(video_processor, "MAX_PLAYBACK_DURATION_MS", 1)
    assert video_handler.handler(upload(s3, data))["results"][0]["status"] == "ready"
    (source,) = tracked
    assert source.bytes_read < len(data) / 4
    assert source.requests < 30


def test_range_file_reads_exact_ranges_of_those_bytes(aws: tuple[Any, Any]) -> None:
    s3, _ = aws
    data = bytes(range(256)) * 40
    etag = s3.put_object(Bucket=BUCKET, Key="k", Body=data)["ETag"]
    f = S3RangeFile(s3, BUCKET, "k", len(data), etag)
    assert f.read(10) == data[:10]
    f.seek(-5, io.SEEK_END)
    assert f.read(100) == data[-5:]
    assert f.read(1) == b""
    f.seek(1000)
    assert f.tell() == 1000
    assert f.read(3) == data[1000:1003]
    assert f.requests == 3

    # Changed in the meantime: S3 refuses the read (412), a transient error.
    s3.put_object(Bucket=BUCKET, Key="k", Body=b"other bytes")
    f.seek(0)
    with pytest.raises(ClientError):
        f.read(4)


def test_range_file_read_limit(aws: tuple[Any, Any]) -> None:
    s3, _ = aws
    etag = s3.put_object(Bucket=BUCKET, Key="k", Body=b"x" * 100)["ETag"]
    f = S3RangeFile(s3, BUCKET, "k", 100, etag, max_bytes=50)
    assert f.read(40) == b"x" * 40
    with pytest.raises(ReadLimitExceeded):
        f.read(20)


# --- Playback copy (14.9) ---------------------------------------------------------------------


def playback_of(s3: Any, key: str = PLAYBACK) -> Any:
    import av

    obj = s3.get_object(Bucket=BUCKET, Key=key)
    container = av.open(io.BytesIO(obj["Body"].read()))
    return obj, container


def test_ready_video_gets_a_playback_copy(aws: tuple[Any, Any], mov_hevc_portrait: bytes) -> None:
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mov_hevc_portrait))

    assert video_handler.handler(upload(s3, mov_hevc_portrait))["results"][0]["status"] == "ready"

    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["playbackStatus"]["S"] == "ready"
    obj, container = playback_of(s3)
    assert obj["ContentType"] == "video/mp4"
    assert obj["CacheControl"] == DERIVED_CACHE_CONTROL
    assert item["playbackSizeBytes"]["N"] == str(obj["ContentLength"])
    with container:
        stream = container.streams.video[0]
        # HEVC portrait → H.264 that every browser plays, already upright.
        assert stream.codec_context.name == "h264"
        assert (stream.width, stream.height) == (240, 320)
    # The app's own file: not counted (FR-ACC-2).
    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["bytesUsed"]["N"] == str(len(mov_hevc_portrait))


def test_long_videos_get_no_copy(
    aws: tuple[Any, Any], mp4_h264: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3, dynamodb = aws
    monkeypatch.setattr(video_processor, "MAX_PLAYBACK_DURATION_MS", 1000)
    put_pending_video(dynamodb, declared=len(mp4_h264))

    video_handler.handler(upload(s3, mp4_h264))

    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert (item["status"]["S"], item["playbackStatus"]["S"]) == ("ready", "skipped")
    assert not exists(s3, PLAYBACK)


def test_videos_from_before_the_copy_get_one(aws: tuple[Any, Any], mp4_h264: bytes) -> None:
    """The backfill: a message for a `ready` video without `playbackStatus` makes only the copy."""
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mp4_h264))
    event = upload(s3, mp4_h264)
    video_handler.handler(event)
    dynamodb.update_item(
        TableName=TABLE,
        Key=ITEM_KEY,
        UpdateExpression="REMOVE playbackStatus, playbackSizeBytes, playbackAt",
    )
    s3.delete_object(Bucket=BUCKET, Key=PLAYBACK)

    result = video_handler.handler(as_sqs(event))

    assert result == {"batchItemFailures": []}
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["playbackStatus"]["S"] == "ready"
    assert exists(s3, PLAYBACK)
    usage = get(dynamodb, USAGE_KEY)
    assert usage is not None
    assert usage["photoCount"]["N"] == "1"


def test_copy_that_runs_out_of_time_fails_alone(
    aws: tuple[Any, Any], mp4_h264: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3, dynamodb = aws
    monkeypatch.setattr("thumbnails.transcode.DEADLINE_CHECK_FRAMES", 1)
    put_pending_video(dynamodb, declared=len(mp4_h264))

    class Context:
        remaining = 600_000

        def get_remaining_time_in_millis(self) -> int:
            # Plenty at the start; then the clock "jumps" while the copy is encoded.
            self.remaining -= 300_000
            return self.remaining

    result = video_handler.handler(as_sqs(upload(s3, mp4_h264)), Context())

    # The message is done: the video is ready and plays its original.
    assert result == {"batchItemFailures": []}
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert (item["status"]["S"], item["playbackStatus"]["S"]) == ("ready", "failed")
    assert "in time" in item["playbackReason"]["S"]
    assert not exists(s3, PLAYBACK)


def test_s3_error_during_the_copy_is_retried(
    aws: tuple[Any, Any], mp4_h264: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mp4_h264))
    event = as_sqs(upload(s3, mp4_h264))
    processor = video_handler._processor()
    real_upload = processor._s3.upload_file

    def down(*_args: Any, **_kwargs: Any) -> Any:
        raise ClientError({"Error": {"Code": "SlowDown", "Message": "slow down"}}, "PutObject")

    monkeypatch.setattr(processor._s3, "upload_file", down)
    assert video_handler.handler(event) == {"batchItemFailures": [{"itemIdentifier": "msg-0"}]}
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert (item["status"]["S"], item["playbackStatus"]["S"]) == ("ready", "pending")

    # The retry finds the video ready and makes only the copy.
    monkeypatch.setattr(processor._s3, "upload_file", real_upload)
    assert video_handler.handler(event) == {"batchItemFailures": []}
    item = get(dynamodb, ITEM_KEY)
    assert item is not None
    assert item["playbackStatus"]["S"] == "ready"


def test_copy_of_a_video_deleted_meanwhile_is_removed(
    aws: tuple[Any, Any], mp4_h264: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mp4_h264))
    processor = video_handler._processor()
    real_upload = processor._s3.upload_file

    def upload_then_delete(*args: Any, **kwargs: Any) -> Any:
        real_upload(*args, **kwargs)
        dynamodb.delete_item(TableName=TABLE, Key=ITEM_KEY)  # the user deleted it for good

    monkeypatch.setattr(processor._s3, "upload_file", upload_then_delete)
    video_handler.handler(upload(s3, mp4_h264))
    assert not exists(s3, PLAYBACK)


def test_replaced_original_loses_its_copy(aws: tuple[Any, Any], mp4_h264: bytes) -> None:
    """12.2b: other bytes under the same key after processing → failed, derived objects go."""
    s3, dynamodb = aws
    put_pending_video(dynamodb, declared=len(mp4_h264))
    video_handler.handler(upload(s3, mp4_h264))
    assert exists(s3, PLAYBACK)

    other = make_video(seconds=3)
    result = video_handler.handler(upload(s3, other))

    assert result["results"][0]["status"] == "failed"
    assert not exists(s3, PLAYBACK)
    assert not exists(s3, THUMB)
