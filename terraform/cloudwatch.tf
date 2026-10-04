# Logs for the EC2 app stack (SPEC-CLOUD.md's single-instance Docker
# Compose setup — see docker-compose.yml). Pre-created here rather than
# left for Docker's `awslogs` driver to auto-create, so retention and log
# class are codified instead of defaulting to Standard class / "never
# expire".
#
# Infrequent Access halves ingestion cost ($0.25/GB vs $0.50/GB) at the
# cost of losing metric filters/alarms/live-tail on these groups — an
# acceptable trade given logs here are searched reactively (a user
# reports a problem, we go look), not alarmed on.
resource "aws_cloudwatch_log_group" "gifiac_app" {
  name              = "/gifiac/app"
  retention_in_days = 7
  log_group_class   = "INFREQUENT_ACCESS"
}

resource "aws_cloudwatch_log_group" "gifiac_caddy" {
  name              = "/gifiac/caddy"
  retention_in_days = 7
  log_group_class   = "INFREQUENT_ACCESS"
}

# Lambda auto-creates these at `/aws/lambda/<function_name>` on first
# invocation (AWSLambdaBasicExecutionRole, lambda.tf) if they don't
# already exist — Standard class, retention "Never expire". Both already
# existed that way (created before this file did) and had to be deleted
# by hand before this apply, since log_group_class can't be changed on
# an existing group; they were empty (0 bytes), so nothing was lost.
resource "aws_cloudwatch_log_group" "gifiac_ingest_lambda" {
  name              = "/aws/lambda/${local.ingest_function_name}"
  retention_in_days = 7
  log_group_class   = "INFREQUENT_ACCESS"
}

resource "aws_cloudwatch_log_group" "gifiac_export_lambda" {
  name              = "/aws/lambda/${local.export_function_name}"
  retention_in_days = 7
  log_group_class   = "INFREQUENT_ACCESS"
}
