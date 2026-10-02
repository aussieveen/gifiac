# No port 22 — deploys and any interactive access go through SSM Session
# Manager / send-command (SPEC-CLOUD.md §10), not SSH. No ALB in front any
# more (COST-REDUCTION-PLAN.md step 1) — Cloudflare proxies straight to
# this instance's Elastic IP, terminating TLS with Caddy on 443 using a
# Cloudflare Origin CA cert, so inbound 80/443 are scoped to Cloudflare's
# published IP ranges rather than 0.0.0.0/0. Re-check
# https://www.cloudflare.com/ips/ periodically — this list is Cloudflare's
# as of 2026-10, and changes rarely but not never.
resource "aws_security_group" "ec2" {
  name = "gifiac-ec2"
  # Left unchanged from the ALB era on purpose: the top-level `description`
  # field is ForceNew on aws_security_group — editing it would replace the
  # whole SG (new ID, detach/reattach from the instance) just to update a
  # comment. The ingress rules below are the actual behavior; they update
  # in-place.
  description = "gifiac app instance - app port from the ALB only, no SSH."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from Cloudflare (redirected to HTTPS by Caddy)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.cloudflare_ipv4_ranges
  }

  ingress {
    description = "HTTPS from Cloudflare"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.cloudflare_ipv4_ranges
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "gifiac-ec2"
  }
}
