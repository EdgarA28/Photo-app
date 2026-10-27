"""One-off backfill (§12.3): album memberships made before albums sorted by date taken get their
GSI1 keys, `GSI1PK = ALBUM#{albumId}` and `GSI1SK = TAKEN#{takenAt}#{photoId}` from the photo.

Without them a membership doesn't show up in its album. Idempotent: memberships that have the keys
are left alone, so it can run again after the API that writes them is deployed.

    AWS_PROFILE=dev uv run python scripts/backfill_album_order.py photo-app-dev [--dry-run]
"""

import sys

import boto3


def main() -> None:
    table = sys.argv[1]
    dry_run = "--dry-run" in sys.argv[2:]
    ddb = boto3.client("dynamodb")

    memberships = []
    for page in ddb.get_paginator("scan").paginate(
        TableName=table,
        FilterExpression="begins_with(PK, :album) AND begins_with(SK, :photo) "
        "AND attribute_not_exists(GSI1PK)",
        ExpressionAttributeValues={":album": {"S": "ALBUM#"}, ":photo": {"S": "PHOTO#"}},
        ProjectionExpression="PK, SK, ownerId, photoId",
    ):
        memberships += page["Items"]

    done = missing = 0
    for item in memberships:
        owner, photo_id = item["ownerId"]["S"], item["photoId"]["S"]
        photo = ddb.get_item(
            TableName=table,
            Key={"PK": {"S": f"USER#{owner}"}, "SK": {"S": f"PHOTO#{photo_id}"}},
            ProjectionExpression="takenAt",
            ConsistentRead=True,
        ).get("Item")
        if photo is None:
            # A dangling membership (photo deleted); the API skips those anyway.
            missing += 1
            continue
        if not dry_run:
            ddb.update_item(
                TableName=table,
                Key={"PK": item["PK"], "SK": item["SK"]},
                UpdateExpression="SET GSI1PK = :pk, GSI1SK = :sk",
                ConditionExpression="attribute_exists(PK)",
                ExpressionAttributeValues={
                    ":pk": item["PK"],
                    ":sk": {"S": f"TAKEN#{photo['takenAt']['S']}#{photo_id}"},
                },
            )
        done += 1
    verb = "would update" if dry_run else "updated"
    print(f"{len(memberships)} without GSI1 keys: {verb} {done}, {missing} without a photo")


if __name__ == "__main__":
    main()
