# Organization-wide cost budget (NFR-COST-2). Created in the management account,
# where consolidated billing makes it cover every member account.

resource "aws_budgets_budget" "monthly" {
  count = var.budget == null ? 0 : 1

  name         = "photo-app-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget.limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget.email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget.email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget.email]
  }
}
