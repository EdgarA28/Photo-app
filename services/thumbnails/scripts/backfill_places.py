"""One-off backfill (13.2d): places for photos processed before the thumbnail Lambda read GPS.

For each `ready` photo without coordinates: read the original's EXIF GPS from S3, look up the
place and write what the Lambda writes for a new photo (`Processor._place_writes`): coordinates
and place on the photo, place list counts, place photo items. Idempotent: photos with coordinates
are skipped, and each write is conditional on that. Run after the API that removes places with
photos is deployed, or deleted photos would leave places behind.

    AWS_PROFILE=dev uv run python scripts/backfill_places.py \
        photo-app-dev photo-app-photos-dev-<account id> [--dry-run]
"""

import io
import sys
from typing import Any

import boto3
from botocore.exceptions import ClientError
from PIL import Image

from thumbnails import imaging, places
from thumbnails.processor import Processor


def main() -> None:
    table, bucket = sys.argv[1], sys.argv[2]
    dry_run = "--dry-run" in sys.argv[3:]
    ddb, s3 = boto3.client("dynamodb"), boto3.client("s3")
    processor = Processor(s3, ddb, table)

    photos: list[dict[str, Any]] = []
    for page in ddb.get_paginator("scan").paginate(
        TableName=table,
        FilterExpression="begins_with(PK, :user) AND begins_with(SK, :photo) "
        # Not trashed photos (FR-DEL-3): their places count them as trashed, not as photos.
        "AND #status = :ready AND attribute_not_exists(latitude) "
        "AND attribute_not_exists(trashedAt)",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":user": {"S": "USER#"},
            ":photo": {"S": "PHOTO#"},
            ":ready": {"S": "ready"},
        },
        ProjectionExpression="PK, SK, originalKey, takenAt",
    ):
        photos += page["Items"]

    found = no_gps = no_town = 0
    for item in photos:
        user_id = item["PK"]["S"].removeprefix("USER#")
        photo_id = item["SK"]["S"].removeprefix("PHOTO#")
        data = s3.get_object(Bucket=bucket, Key=item["originalKey"]["S"])["Body"].read()
        with Image.open(io.BytesIO(data), formats=imaging.ALLOWED_FORMATS) as img:
            gps = imaging._gps(img.getexif())
        if gps is None:
            no_gps += 1
            continue
        place = places.lookup(*gps)
        if place is None:
            no_town += 1
        else:
            found += 1
            print(f"{photo_id}: {place.city}, {place.region}, {place.country}")
        if dry_run:
            continue
        set_clause, values, place_items = processor._place_writes(
            user_id, photo_id, item["takenAt"]["S"], gps, place
        )
        try:
            ddb.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": table,
                            "Key": {"PK": item["PK"], "SK": item["SK"]},
                            "UpdateExpression": "SET " + set_clause.removeprefix(", "),
                            "ConditionExpression": "#status = :ready "
                            "AND attribute_not_exists(latitude) "
                            "AND attribute_not_exists(trashedAt)",
                            "ExpressionAttributeNames": {"#status": "status"},
                            "ExpressionAttributeValues": {**values, ":ready": {"S": "ready"}},
                        }
                    },
                    *place_items,
                ]
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "TransactionCanceledException":
                raise
            print(f"{photo_id}: changed meanwhile (deleted or done), skipped")

    verb = "would write" if dry_run else "wrote"
    print(
        f"{len(photos)} ready photos without coordinates: {verb} {found} with a place, "
        f"{no_town} with coordinates only (no town within {places.MAX_DISTANCE_KM} km), "
        f"{no_gps} without GPS"
    )


if __name__ == "__main__":
    main()
