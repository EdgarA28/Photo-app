"""Dry run of Gallery stacks (8.37d; FR-GAL-10/11, spec §12.3): which stacks the web app would
make from the photos on an environment, to tune the thresholds on real bursts before 8.37e.

Reads every user's Gallery photos (ready, not trashed, not videos) from DynamoDB and groups them
like §12.3: in date-taken order (newest first), a photo joins the stack above it while it was
taken at most `--seconds` after/before the previous photo and its `similarityHash` is at most
`--bits` from some photo already in the stack. Top pick: newest `topPickAt`, else the sharpest,
else the first. Writes nothing to AWS.

Prints a summary per user and, with `--html`, writes a local contact sheet (thumbnails embedded,
so it works offline and nothing is uploaded anywhere): each stack with its top pick marked, and
the near misses (taken within `--seconds` but more than `--bits` apart), which show whether the
bit threshold is too strict.

    AWS_PROFILE=dev uv run python scripts/stack_dry_run.py photo-app-dev \
        photo-app-photos-dev-<account id> [--seconds 60] [--bits 10] [--html stacks.html]
"""

import argparse
import base64
import html
import itertools
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from thumbnails.s3_keys import thumb_key
from thumbnails.similarity import hamming_distance

DEFAULT_SECONDS = 60
DEFAULT_BITS = 10
NEAR_MISS_EXTRA_BITS = 10
"""Near misses shown: within the time limit and up to this many bits over the threshold."""


@dataclass(frozen=True)
class Photo:
    user_id: str
    photo_id: str
    file_name: str
    taken_at: str
    similarity_hash: str | None
    sharpness: float | None
    top_pick_at: str | None

    @property
    def taken(self) -> datetime:
        return datetime.fromisoformat(self.taken_at)


def group_stacks(photos: Sequence[Photo], max_seconds: float, max_bits: int) -> list[list[Photo]]:
    """§12.3 grouping of one user's photos, given newest first. Every photo is in exactly one
    group; groups of one are single tiles. A photo without a hash stays single and ends the
    stack above it."""
    groups: list[list[Photo]] = []
    for photo in photos:
        current = groups[-1] if groups else None
        if (
            current is not None
            and photo.similarity_hash is not None
            and current[-1].similarity_hash is not None
            and abs((current[-1].taken - photo.taken).total_seconds()) <= max_seconds
            and any(
                hamming_distance(photo.similarity_hash, member.similarity_hash) <= max_bits
                for member in current
                if member.similarity_hash is not None
            )
        ):
            current.append(photo)
        else:
            groups.append([photo])
    return groups


def top_pick(stack: Sequence[Photo]) -> Photo:
    """FR-GAL-11: the user's newest choice, else the sharpest, else the first."""
    picked = [p for p in stack if p.top_pick_at is not None]
    if picked:
        return max(picked, key=lambda p: p.top_pick_at or "")
    rated = [p for p in stack if p.sharpness is not None]
    if rated:
        return max(rated, key=lambda p: p.sharpness or 0.0)
    return stack[0]


def near_misses(
    photos: Sequence[Photo], max_seconds: float, max_bits: int
) -> list[tuple[Photo, Photo, int]]:
    """Neighbours (newest first) taken within the time limit whose hashes are just too far apart
    to stack: (newer, older, bits)."""
    misses = []
    for newer, older in itertools.pairwise(photos):
        if newer.similarity_hash is None or older.similarity_hash is None:
            continue
        if abs((newer.taken - older.taken).total_seconds()) > max_seconds:
            continue
        bits = hamming_distance(newer.similarity_hash, older.similarity_hash)
        if max_bits < bits <= max_bits + NEAR_MISS_EXTRA_BITS:
            misses.append((newer, older, bits))
    return misses


def load_photos(ddb: Any, table: str) -> dict[str, list[Photo]]:
    """Gallery photos per user, newest first (GSI1SK order: takenAt, then photo ID)."""
    by_user: dict[str, list[Photo]] = {}
    for page in ddb.get_paginator("scan").paginate(
        TableName=table,
        FilterExpression="begins_with(PK, :user) AND begins_with(SK, :photo) "
        "AND #status = :ready AND attribute_not_exists(trashedAt) "
        "AND (attribute_not_exists(mediaType) OR mediaType = :photoType)",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":user": {"S": "USER#"},
            ":photo": {"S": "PHOTO#"},
            ":ready": {"S": "ready"},
            ":photoType": {"S": "photo"},
        },
        ProjectionExpression="PK, SK, fileName, takenAt, similarityHash, sharpness, topPickAt",
    ):
        for item in page["Items"]:
            photo = Photo(
                user_id=item["PK"]["S"].removeprefix("USER#"),
                photo_id=item["SK"]["S"].removeprefix("PHOTO#"),
                file_name=item.get("fileName", {}).get("S", ""),
                taken_at=item["takenAt"]["S"],
                similarity_hash=item.get("similarityHash", {}).get("S"),
                sharpness=float(item["sharpness"]["N"]) if "sharpness" in item else None,
                top_pick_at=item.get("topPickAt", {}).get("S"),
            )
            by_user.setdefault(photo.user_id, []).append(photo)
    for photos in by_user.values():
        photos.sort(key=lambda p: (p.taken_at, p.photo_id), reverse=True)
    return by_user


def summary(user_id: str, photos: Sequence[Photo], stacks: list[list[Photo]], misses: list) -> str:
    stacked = [s for s in stacks if len(s) > 1]
    in_stacks = sum(len(s) for s in stacked)
    lines = [
        f"user {user_id[:8]}: {len(photos)} photos → {len(stacks)} tiles; "
        f"{len(stacked)} stacks holding {in_stacks} photos; {len(misses)} near misses"
    ]
    for stack in stacked:
        pick = top_pick(stack)
        names = ", ".join(("*" if p is pick else "") + p.file_name for p in stack)
        lines.append(f"  {stack[0].taken_at[:19]}  {len(stack)} photos: {names}")
    return "\n".join(lines)


def write_html(
    path: str,
    s3: Any,
    bucket: str,
    sections: list[tuple[str, list[list[Photo]], list[tuple[Photo, Photo, int]]]],
    max_seconds: float,
    max_bits: int,
) -> None:
    wanted = {
        (p.user_id, p.photo_id): p
        for _, stacks, misses in sections
        for p in [
            *(p for s in stacks if len(s) > 1 for p in s),
            *(p for m in misses for p in m[:2]),
        ]
    }

    def fetch(photo: Photo) -> tuple[tuple[str, str], str]:
        body = s3.get_object(Bucket=bucket, Key=thumb_key(photo.user_id, photo.photo_id))
        data = base64.b64encode(body["Body"].read()).decode()
        return (photo.user_id, photo.photo_id), f"data:image/jpeg;base64,{data}"

    with ThreadPoolExecutor(8) as pool:
        images = dict(pool.map(fetch, wanted.values()))

    def tile(photo: Photo, note: str, pick: bool = False) -> str:
        src = images[(photo.user_id, photo.photo_id)]
        sharp = f"{photo.sharpness:.0f}" if photo.sharpness is not None else "-"
        return (
            f'<figure class="{"pick" if pick else ""}"><img src="{src}" alt="">'
            f"<figcaption>{html.escape(photo.file_name)}<br>{photo.taken_at[11:19]} · "
            f"sharp {sharp}{' · ' + note if note else ''}{' · TOP PICK' if pick else ''}"
            "</figcaption></figure>"
        )

    parts = [
        "<!doctype html><meta charset=utf-8><title>Stack dry run</title><style>"
        "body{font:14px system-ui;margin:24px;background:#111;color:#ddd}"
        "h2{margin-top:40px}h3{margin:24px 0 8px;font-weight:500}"
        ".row{display:flex;flex-wrap:wrap;gap:8px}"
        "figure{margin:0;width:180px}img{width:180px;height:180px;object-fit:cover;"
        "border-radius:4px;border:3px solid transparent}"
        ".pick img{border-color:#4ade80}figcaption{font-size:12px;color:#aaa;margin-top:4px;"
        "word-break:break-all}</style>",
        f"<h1>Stack dry run</h1><p>Rules: ≤ {max_seconds:g} s between neighbours, hash ≤ "
        f"{max_bits} bits from a photo in the stack. Green = top pick (sharpest).</p>",
    ]
    for user_id, stacks, misses in sections:
        stacked = [s for s in stacks if len(s) > 1]
        parts.append(f"<h2>User {html.escape(user_id[:8])}: {len(stacked)} stacks</h2>")
        for stack in stacked:
            pick = top_pick(stack)
            first = stack[0].similarity_hash or ""
            parts.append(f"<h3>{stack[0].taken_at[:10]} · {len(stack)} photos</h3><div class=row>")
            for photo in stack:
                bits = hamming_distance(first, photo.similarity_hash or first)
                parts.append(
                    tile(photo, f"{bits} bits" if photo is not stack[0] else "", photo is pick)
                )
            parts.append("</div>")
        if misses:
            parts.append(
                f"<h2>User {html.escape(user_id[:8])}: near misses (within {max_seconds:g} s, "
                f"{max_bits + 1} to {max_bits + NEAR_MISS_EXTRA_BITS} bits): "
                "should these stack?</h2>"
            )
            for newer, older, bits in misses:
                parts.append(f"<h3>{bits} bits apart</h3><div class=row>")
                parts.append(tile(newer, "") + tile(older, ""))
                parts.append("</div>")
    with open(path, "w", encoding="utf-8") as out:
        out.write("".join(parts))


def main() -> None:
    import boto3

    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("table")
    parser.add_argument("bucket")
    parser.add_argument("--seconds", type=float, default=DEFAULT_SECONDS)
    parser.add_argument("--bits", type=int, default=DEFAULT_BITS)
    parser.add_argument("--html", help="write a contact sheet with the thumbnails to this file")
    args = parser.parse_args()

    by_user = load_photos(boto3.client("dynamodb"), args.table)
    sections = []
    for user_id, photos in sorted(by_user.items(), key=lambda kv: -len(kv[1])):
        stacks = group_stacks(photos, args.seconds, args.bits)
        misses = near_misses(photos, args.seconds, args.bits)
        print(summary(user_id, photos, stacks, misses))
        sections.append((user_id, stacks, misses))
    if args.html:
        write_html(args.html, boto3.client("s3"), args.bucket, sections, args.seconds, args.bits)
        print(f"Contact sheet: {args.html}")


if __name__ == "__main__":
    main()
