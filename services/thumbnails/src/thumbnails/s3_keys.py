"""Python mirror of packages/shared/src/s3Keys.ts (spec §8.1, task 6.6).

Both implementations are tested against packages/shared/test-vectors/s3-keys.json.

    users/{userId}/originals/{photoId}.{ext}
    users/{userId}/thumbs/{photoId}.jpg
    users/{userId}/previews/{photoId}.jpg
"""

import re
from dataclasses import dataclass

# Mirrors CONTENT_TYPE_EXTENSIONS / ORIGINAL_EXTENSIONS in packages/shared/src/constants.ts.
ORIGINAL_EXTENSIONS = ("jpg", "png", "heic", "heif", "webp")

# Mirrors ULID_REGEX / USER_ID_REGEX in packages/shared/src/ids.ts.
ULID_REGEX = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}")
USER_ID_REGEX = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

_ORIGINAL_KEY_REGEX = re.compile(
    rf"users/([^/]+)/originals/([^/.]+)\.({'|'.join(ORIGINAL_EXTENSIONS)})"
)


@dataclass(frozen=True)
class ParsedOriginalKey:
    user_id: str
    photo_id: str
    ext: str


def is_id(value: str) -> bool:
    return ULID_REGEX.fullmatch(value) is not None


def is_user_id(value: str) -> bool:
    return USER_ID_REGEX.fullmatch(value) is not None


def _assert_ids(user_id: str, photo_id: str) -> None:
    if not is_user_id(user_id):
        raise ValueError(f"Invalid userId: {user_id}")
    if not is_id(photo_id):
        raise ValueError(f"Invalid photoId: {photo_id}")


def user_prefix(user_id: str) -> str:
    if not is_user_id(user_id):
        raise ValueError(f"Invalid userId: {user_id}")
    return f"users/{user_id}/"


def original_key(user_id: str, photo_id: str, ext: str) -> str:
    _assert_ids(user_id, photo_id)
    if ext not in ORIGINAL_EXTENSIONS:
        raise ValueError(f"Invalid extension: {ext}")
    return f"users/{user_id}/originals/{photo_id}.{ext}"


def thumb_key(user_id: str, photo_id: str) -> str:
    _assert_ids(user_id, photo_id)
    return f"users/{user_id}/thumbs/{photo_id}.jpg"


def preview_key(user_id: str, photo_id: str) -> str:
    _assert_ids(user_id, photo_id)
    return f"users/{user_id}/previews/{photo_id}.jpg"


def parse_original_key(key: str) -> ParsedOriginalKey | None:
    """Returns None for anything that is not a well-formed original key (loop protection, §10)."""
    match = _ORIGINAL_KEY_REGEX.fullmatch(key)
    if match is None:
        return None
    user_id, photo_id, ext = match.groups()
    if not is_user_id(user_id) or not is_id(photo_id):
        return None
    return ParsedOriginalKey(user_id=user_id, photo_id=photo_id, ext=ext)
