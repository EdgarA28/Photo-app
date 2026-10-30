# Offline tests: mocked AWS provider, nothing is created. Run: tofu test
mock_provider "aws" {}

variables {
  table_name = "photo-app-test"
}

run "single_table_keys_and_gsi" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.main.billing_mode == "PAY_PER_REQUEST"
    error_message = "Table must be on-demand (NFR-COST-1)."
  }

  assert {
    condition     = aws_dynamodb_table.main.hash_key == "PK" && aws_dynamodb_table.main.range_key == "SK"
    error_message = "Primary key must be PK/SK (spec §8.2)."
  }

  assert {
    condition = anytrue([
      for gsi in aws_dynamodb_table.main.global_secondary_index :
      gsi.name == "GSI1" && gsi.projection_type == "ALL" &&
      [for k in gsi.key_schema : "${k.attribute_name}:${k.key_type}"] == ["GSI1PK:HASH", "GSI1SK:RANGE"]
    ])
    error_message = "GSI1 (GSI1PK/GSI1SK, ALL) is required for the gallery and shared albums."
  }
}

run "safe_defaults" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.main.deletion_protection_enabled == true
    error_message = "Deletion protection must default to on."
  }

  assert {
    condition     = aws_dynamodb_table.main.point_in_time_recovery[0].enabled == false
    error_message = "PITR defaults to off (enabled per environment)."
  }
}

run "prod_settings" {
  command = plan

  variables {
    point_in_time_recovery = true
    deletion_protection    = true
  }

  assert {
    condition     = aws_dynamodb_table.main.point_in_time_recovery[0].enabled == true
    error_message = "PITR must be enabled when requested."
  }
}

run "expiring_items" {
  command = plan

  assert {
    condition     = one(aws_dynamodb_table.main.ttl).attribute_name == "ttl" && one(aws_dynamodb_table.main.ttl).enabled
    error_message = "Items with a `ttl` attribute expire (photo links, FR-SHR-8)."
  }
}
