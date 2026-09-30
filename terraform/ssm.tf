# SecureString parameters under /gifiac/ — the four SPEC-CLOUD.md §10
# secret names exactly. Non-secret config stays as plain env vars in
# docker-compose.yml, unchanged.

resource "aws_ssm_parameter" "db_password" {
  name  = "/gifiac/db_password"
  type  = "SecureString"
  value = random_password.db.result
}

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
# same as random_password.db above, rather than a human-supplied tfvar
# like google_client_secret/r2_*.
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
