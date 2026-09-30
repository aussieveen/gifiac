# SES for email login-code delivery (SPEC-EMAIL-AUTH.md §7/§8). DNS is
# not managed in Terraform here (see terraform/README.md — no Cloudflare
# provider is configured), so unlike a typical SES setup this doesn't
# create any DNS records itself; `outputs.tf`'s `ses_dns_records` lists
# everything that needs adding manually, the same pattern
# `acm_validation_records` already uses for the ACM certificate.

resource "aws_sesv2_email_identity" "main" {
  email_identity = var.domain_name
  # Easy DKIM (the default signing configuration) — no explicit
  # `dkim_signing_attributes` block needed beyond naming the identity.
}

# A custom MAIL FROM domain, on a subdomain of the app's own domain — SES
# requires this to be a subdomain, never the root, and it must be
# different from anything else already using the root for MX/SPF (the
# root domain here already has Cloudflare Email Routing's own MX/SPF, per
# terraform/README.md's DNS constraints — this stays fully separate on
# `mail.<domain>`).
resource "aws_sesv2_email_identity_mail_from_attributes" "main" {
  email_identity   = aws_sesv2_email_identity.main.email_identity
  mail_from_domain = "mail.${var.domain_name}"
}
