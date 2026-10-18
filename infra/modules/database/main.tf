# Single-table design (spec §8.2). Entities and keys:
#   Photo             PK USER#{userId}   SK PHOTO#{photoId}   GSI1 USER#{userId} / TAKEN#{takenAt}#{photoId}
#   Album             PK USER#{ownerId}  SK ALBUM#{albumId}
#   Album membership  PK ALBUM#{albumId} SK PHOTO#{photoId}
#   Album share       PK ALBUM#{albumId} SK SHARE#{userId}    GSI1 SHAREDWITH#{userId} / ALBUM#{albumId}
#   Usage             PK USER#{userId}   SK USAGE

resource "aws_dynamodb_table" "main" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  # Gallery by date taken; albums shared with a user.
  global_secondary_index {
    name            = "GSI1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  # Encryption at rest with the AWS-owned key (NFR-SEC-4); no KMS cost.
  server_side_encryption {
    enabled = false
  }
}
