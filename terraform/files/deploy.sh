#!/usr/bin/env bash
# Fetches secrets from SSM Parameter Store, combines them with the
# non-secret config baked into /opt/gifiac/config.env at instance creation
# (see user_data.sh.tftpl), writes /opt/gifiac/.env, and pulls + (re)starts
# the app (SPEC-CLOUD.md §10). Run at first boot by user_data.sh.tftpl, and
# again on every push to main via the GitHub Actions deploy job (aws ssm
# send-command running this same script).
set -euo pipefail

cd /opt/gifiac
source ./config.env

get_param() {
  aws ssm get-parameter --name "/gifiac/$1" --with-decryption --query 'Parameter.Value' --output text
}

DB_PASSWORD="$(get_param db_password)"
GOOGLE_CLIENT_SECRET="$(get_param google_client_secret)"
R2_ACCESS_KEY_ID="$(get_param r2_access_key_id)"
R2_SECRET_ACCESS_KEY="$(get_param r2_secret_access_key)"

cat > .env <<EOF
DATABASE_URL=postgres://gifiac:${DB_PASSWORD}@${RDS_ENDPOINT}/gifiac?sslmode=require
R2_ACCOUNT_ID=${R2_ACCOUNT_ID}
R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
R2_BUCKET_NAME=${R2_BUCKET_NAME}
R2_PUBLIC_BASE_URL=${R2_PUBLIC_BASE_URL}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
APP_BASE_URL=${APP_BASE_URL}
SOURCE_VIDEOS_S3_BUCKET=${SOURCE_VIDEOS_S3_BUCKET}
SOURCE_VIDEOS_S3_REGION=${SOURCE_VIDEOS_S3_REGION}
TEMPLATE_ASSETS_S3_BUCKET=${TEMPLATE_ASSETS_S3_BUCKET}
TEMPLATE_ASSETS_S3_REGION=${TEMPLATE_ASSETS_S3_REGION}
EOF
chmod 600 .env

docker compose pull
docker compose up -d
