output "app_elastic_ip" {
  description = "Point the domain's DNS at this in Cloudflare, with the record proxied (orange-cloud) — no ALB any more (COST-REDUCTION-PLAN.md step 1)."
  value       = aws_eip.app.public_ip
}

output "source_videos_bucket_name" {
  description = "The private S3 bucket name for SOURCE_VIDEOS_S3_BUCKET."
  value       = aws_s3_bucket.source_videos.bucket
}

output "template_assets_bucket_name" {
  description = "The private S3 bucket name for TEMPLATE_ASSETS_S3_BUCKET."
  value       = aws_s3_bucket.template_assets.bucket
}

output "github_deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN GitHub repo variable."
  value       = aws_iam_role.deploy.arn
}

output "ingest_lambda_ecr_repository_url" {
  description = "Where lambda-publish.yml pushes the ingest Lambda's container image."
  value       = aws_ecr_repository.ingest_lambda.repository_url
}

output "export_lambda_ecr_repository_url" {
  description = "Where lambda-publish.yml pushes the export Lambda's container image."
  value       = aws_ecr_repository.export_lambda.repository_url
}

# SPEC-EMAIL-AUTH.md §8 — same "DNS isn't managed here, so list the
# records to add manually" pattern as acm_validation_records. Root-domain
# constraints (do not touch existing MX/SPF, only add a _dmarc record if
# none exists yet) are documented in terraform/README.md and can't be
# enforced from here without a DNS-reading provider this project doesn't
# have — the human applying these should double-check both before adding.
output "ses_dns_records" {
  description = "DNS records to add wherever the domain's DNS is hosted, to verify SES sending. DKIM CNAMEs and the MAIL FROM MX/SPF go on the mail_from_domain shown in each record's own \"name\" — do not touch the root domain's existing MX/SPF records (Cloudflare Email Routing). Add the _dmarc TXT record only if one doesn't already exist."
  value = concat(
    [
      for token in aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens : {
        name  = "${token}._domainkey.${var.ses_domain_name}"
        type  = "CNAME"
        value = "${token}.dkim.amazonses.com"
      }
    ],
    [
      {
        name  = aws_sesv2_email_identity_mail_from_attributes.main.mail_from_domain
        type  = "MX"
        value = "10 feedback-smtp.${var.aws_region}.amazonses.com"
      },
      {
        name  = aws_sesv2_email_identity_mail_from_attributes.main.mail_from_domain
        type  = "TXT"
        value = "v=spf1 include:amazonses.com ~all"
      },
      {
        name  = "_dmarc.${var.ses_domain_name}"
        type  = "TXT"
        value = "v=DMARC1; p=none; rua=mailto:${var.email_from_address}"
      },
    ]
  )
}
