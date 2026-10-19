"""S3 key mirror vs. the shared test vectors (spec §8.1, task 6.6)."""

import json
from pathlib import Path

import pytest

from thumbnails.s3_keys import (
    ParsedOriginalKey,
    original_key,
    parse_original_key,
    preview_key,
    thumb_key,
    user_prefix,
)

VECTORS = json.loads(
    (
        Path(__file__).parents[3] / "packages" / "shared" / "test-vectors" / "s3-keys.json"
    ).read_text()
)


@pytest.mark.parametrize("v", VECTORS["valid"], ids=lambda v: v["original"])
def test_builders_match_vectors(v: dict[str, str]) -> None:
    assert original_key(v["userId"], v["photoId"], v["ext"]) == v["original"]
    assert thumb_key(v["userId"], v["photoId"]) == v["thumb"]
    assert preview_key(v["userId"], v["photoId"]) == v["preview"]


@pytest.mark.parametrize("v", VECTORS["valid"], ids=lambda v: v["original"])
def test_parse_valid(v: dict[str, str]) -> None:
    assert parse_original_key(v["original"]) == ParsedOriginalKey(
        user_id=v["userId"], photo_id=v["photoId"], ext=v["ext"]
    )


@pytest.mark.parametrize("key", VECTORS["invalidOriginalKeys"])
def test_parse_rejects(key: str) -> None:
    assert parse_original_key(key) is None


def test_parse_rejects_trailing_newline() -> None:
    assert parse_original_key(VECTORS["valid"][0]["original"] + "\n") is None


def test_builders_reject_invalid_ids() -> None:
    v = VECTORS["valid"][0]
    with pytest.raises(ValueError):
        original_key("../other", v["photoId"], "jpg")
    with pytest.raises(ValueError):
        original_key(v["userId"], v["photoId"], "gif")
    with pytest.raises(ValueError):
        thumb_key(v["userId"], "not-a-ulid")
    with pytest.raises(ValueError):
        preview_key(v["userId"].upper(), v["photoId"])
    with pytest.raises(ValueError):
        user_prefix("")


def test_user_prefix() -> None:
    v = VECTORS["valid"][0]
    assert user_prefix(v["userId"]) == f"users/{v['userId']}/"
