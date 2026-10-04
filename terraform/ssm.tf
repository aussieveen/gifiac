# SecureString parameters under /gifiac/ — the four SPEC-CLOUD.md §10
# secret names exactly. Non-secret config stays as plain env vars in
# docker-compose.yml, unchanged.

resource "aws_ssm_parameter" "google_client_secret" {
  name  = "/gifiac/google_client_secret"
  type  = "SecureString"
  value = var.google_client_secret
}

resource "aws_ssm_parameter" "r2_access_key_id" {
  name  = "/gifiac/r2_access_key_id"
  type  = "SecureString"
  value = var.r2_access_key_id
}

resource "aws_ssm_parameter" "r2_secret_access_key" {
  name  = "/gifiac/r2_secret_access_key"
  type  = "SecureString"
  value = var.r2_secret_access_key
}

# SPEC-EMAIL-AUTH.md §2/§12 — purely internal to the app (HMACs the email
# login code before it's stored; nothing external ever needs to know or
# match this value), so it's Terraform-generated straight into SSM, the
# same as random_password.postgres_local below, rather than a
# human-supplied tfvar like google_client_secret/r2_*.
resource "random_id" "login_code_hmac_key" {
  byte_length = 32
}

resource "aws_ssm_parameter" "login_code_hmac_key" {
  name  = "/gifiac/login_code_hmac_key"
  type  = "SecureString"
  value = random_id.login_code_hmac_key.b64_std
}

resource "aws_ssm_parameter" "turnstile_secret_key" {
  name  = "/gifiac/turnstile_secret_key"
  type  = "SecureString"
  value = var.turnstile_secret_key
}

# Shared bearer token the ingest/export Lambda functions' callbacks
# authenticate with (wayfinder gifiac#32, piece 3's `verify_callback_token`)
# — purely internal (the backend hands it to Lambda per-invocation via the
# invoke payload, Lambda just echoes it back), so it's Terraform-generated
# straight into SSM, the same reasoning as login_code_hmac_key above.
resource "random_id" "lambda_callback_token" {
  byte_length = 32
}

resource "aws_ssm_parameter" "lambda_callback_token" {
  name  = "/gifiac/lambda_callback_token"
  type  = "SecureString"
  value = random_id.lambda_callback_token.b64_std
}

# Caddy's TLS files, not env vars — deploy.sh writes these straight to
# disk for the caddy container to mount (COST-REDUCTION-PLAN.md step 1).
resource "aws_ssm_parameter" "cloudflare_origin_cert" {
  name  = "/gifiac/cloudflare_origin_cert"
  type  = "SecureString"
  value = var.cloudflare_origin_cert
}

resource "aws_ssm_parameter" "cloudflare_origin_key" {
  name  = "/gifiac/cloudflare_origin_key"
  type  = "SecureString"
  value = var.cloudflare_origin_key
}

# Password for the Postgres container running on the instance itself
# (COST-REDUCTION-PLAN.md step 2, now RDS's replacement).
resource "random_password" "postgres_local" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "postgres_local_password" {
  name  = "/gifiac/postgres_local_password"
  type  = "SecureString"
  value = random_password.postgres_local.result
}
