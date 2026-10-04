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

GOOGLE_CLIENT_SECRET="$(get_param google_client_secret)"
R2_ACCESS_KEY_ID="$(get_param r2_access_key_id)"
R2_SECRET_ACCESS_KEY="$(get_param r2_secret_access_key)"
LOGIN_CODE_HMAC_KEY="$(get_param login_code_hmac_key)"
TURNSTILE_SECRET_KEY="$(get_param turnstile_secret_key)"
POSTGRES_PASSWORD="$(get_param postgres_local_password)"
LAMBDA_CALLBACK_TOKEN="$(get_param lambda_callback_token)"

mkdir -p certs
get_param cloudflare_origin_cert > certs/origin.pem
get_param cloudflare_origin_key > certs/origin.key
chmod 600 certs/origin.pem certs/origin.key

cat > .env <<EOF
AWS_REGION=${AWS_REGION}
DATABASE_URL=postgres://gifiac:${POSTGRES_PASSWORD}@postgres:5432/gifiac?sslmode=disable
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
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
LOGIN_CODE_HMAC_KEY=${LOGIN_CODE_HMAC_KEY}
MAILER=ses
EMAIL_FROM_ADDRESS=${EMAIL_FROM_ADDRESS}
SES_REGION=${SES_REGION}
TURNSTILE_SECRET_KEY=${TURNSTILE_SECRET_KEY}
TURNSTILE_SITE_KEY=${TURNSTILE_SITE_KEY}
TRUST_CF_CONNECTING_IP=${TRUST_CF_CONNECTING_IP}
INGEST_LAMBDA_FUNCTION_NAME=${INGEST_LAMBDA_FUNCTION_NAME}
EXPORT_LAMBDA_FUNCTION_NAME=${EXPORT_LAMBDA_FUNCTION_NAME}
CALLBACK_BASE_URL=${CALLBACK_BASE_URL}
LAMBDA_CALLBACK_TOKEN=${LAMBDA_CALLBACK_TOKEN}
EOF
chmod 600 .env

docker compose pull
docker compose up -d

# Nightly pg_dump to S3 (COST-REDUCTION-PLAN.md step 2) — RDS's own
# managed backups go away once it's destroyed, so this replaces them.
# Written on every deploy, not just first boot, so changes here reach
# the instance the same way deploy.sh/docker-compose.yml do; `systemctl
# enable --now` on an already-enabled/running timer is a no-op, so this
# is safe to repeat.
cat > /opt/gifiac/backup.sh <<'GIFIAC_BACKUP_EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/gifiac
source ./config.env
ts="$(date -u +%Y%m%d%H%M%S)"
docker exec postgres pg_dump -U gifiac -d gifiac \
  | gzip \
  | aws s3 cp - "s3://${TEMPLATE_ASSETS_S3_BUCKET}/postgres-backups/gifiac-${ts}.sql.gz"
GIFIAC_BACKUP_EOF
chmod +x /opt/gifiac/backup.sh

cat > /etc/systemd/system/gifiac-backup.service <<'GIFIAC_BACKUP_SERVICE_EOF'
[Unit]
Description=gifiac nightly postgres backup to S3

[Service]
Type=oneshot
ExecStart=/opt/gifiac/backup.sh
GIFIAC_BACKUP_SERVICE_EOF

cat > /etc/systemd/system/gifiac-backup.timer <<'GIFIAC_BACKUP_TIMER_EOF'
[Unit]
Description=Run gifiac-backup nightly

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
GIFIAC_BACKUP_TIMER_EOF

systemctl daemon-reload
systemctl enable --now gifiac-backup.timer
