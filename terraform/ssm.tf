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
