# Hard safety check against applying to the wrong AWS account — real risk
# here since most of this machine's AWS config points at work accounts,
# not personal. Unlike a `check` block (which only warns and lets `apply`
# proceed anyway), a `lifecycle.precondition` actually fails `plan`/`apply`
# outright, before touching a single resource, if the resolved account
# doesn't match. Reuses `data.aws_caller_identity.current` from iam.tf
# rather than redeclaring it.
resource "terraform_data" "account_guard" {
  input = data.aws_caller_identity.current.account_id

  lifecycle {
    precondition {
      condition     = var.expected_aws_account_id == null || data.aws_caller_identity.current.account_id == var.expected_aws_account_id
      error_message = "Resolved AWS account is ${data.aws_caller_identity.current.account_id}, but expected_aws_account_id is set to ${coalesce(var.expected_aws_account_id, "<unset>")}. This looks like the wrong AWS profile/account — check aws_profile / AWS_PROFILE before re-running."
    }
  }
}
