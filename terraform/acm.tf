# DNS validation, no Route53 automation — the domain's DNS isn't in
# Route53 (lives elsewhere: Cloudflare, Namecheap, etc.). The validation
# CNAME(s) come out as a Terraform output for the user to add manually
# wherever DNS actually lives; see terraform/README.md for the resulting
# two-phase apply.
resource "aws_acm_certificate" "app" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "gifiac"
  }
}
