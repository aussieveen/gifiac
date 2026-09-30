variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "eu-west-1"
}

variable "aws_profile" {
  description = "Named AWS CLI profile to authenticate with (e.g. \"personal\"). Leave unset to fall back to the default credential chain (AWS_PROFILE env var, env credentials, IMDS, etc.) — GitHub Actions' OIDC-assumed role never sets this, it always uses the default chain."
  type        = string
  default     = null
}

variable "expected_aws_account_id" {
  description = "The AWS account id this deployment must run against — set this to your personal account's id and every plan/apply hard-fails (see account_guard.tf) if the resolved profile/credentials point somewhere else, e.g. a work account. Leave unset to skip the check."
  type        = string
  default     = null
}

variable "domain_name" {
  description = "Domain the app is served on. DNS is not hosted in Route53 (see terraform/README.md) — this only names the ACM certificate and APP_BASE_URL; the user points DNS at the ALB manually."
  type        = string
}

variable "ses_domain_name" {
  description = "Domain SES sends login-code emails from — deliberately separate from domain_name: SES verification only flows parent-to-child (verifying this domain also authorizes any subdomain of it, but not the reverse), and domain_name here is a `www.` subdomain the app happens to be served on. Defaults to the apex of domain_name isn't derived automatically (fragile string-stripping); set it explicitly. email_from_address must be on this domain or a subdomain of it."
  type        = string
}

variable "github_repository" {
  description = "GitHub \"owner/repo\" allowed to assume the deploy role via OIDC."
  type        = string
  default     = "aussieveen/gifiac"
}

variable "github_oidc_subject" {
  description = "Full expected `sub` claim on the GitHub Actions OIDC token, scoping the deploy role's trust policy. Defaults to the plain \"repo:OWNER/REPO:ref:refs/heads/main\" format (built from github_repository) — override this if the account/org has GitHub's \"immutable\" OIDC subject claims enabled (Settings -> Actions -> General -> Workflow permissions), which embeds stable numeric owner/repo IDs instead: \"repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/main\". Find the exact value from a failed AssumeRoleWithWebIdentity attempt's CloudTrail event (userIdentity.principalId / userName)."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "EC2 instance type. ffmpeg transcoding is CPU/memory-hungry enough that the cheapest t3.micro risks OOM-killing an export."
  type        = string
  default     = "t3.medium"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage, in GiB."
  type        = number
  default     = 20
}

variable "ec2_root_volume_size" {
  description = "EC2 root volume size, in GiB. Docker images plus the lazy source-video disk cache need headroom beyond the AMI default."
  type        = number
  default     = 40
}

variable "r2_account_id" {
  description = "Cloudflare R2 account ID (non-secret, but has no sensible default — supplied via terraform.tfvars)."
  type        = string
}

variable "r2_bucket_name" {
  description = "Cloudflare R2 bucket name for GIF/export output (non-secret)."
  type        = string
}

variable "r2_public_base_url" {
  description = "Public base URL the R2 output bucket is served from (non-secret)."
  type        = string
}

variable "google_client_id" {
  description = "Google OAuth client ID (non-secret; the matching client secret is google_client_secret below)."
  type        = string
}

variable "google_client_secret" {
  description = "Google OAuth client secret (SPEC-CLOUD.md §2). Supplied via terraform.tfvars or TF_VAR_google_client_secret — never committed."
  type        = string
  sensitive   = true
}

variable "r2_access_key_id" {
  description = "Cloudflare R2 access key ID for the GIF/export output bucket. Supplied via terraform.tfvars or TF_VAR_r2_access_key_id — never committed."
  type        = string
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "Cloudflare R2 secret access key for the GIF/export output bucket. Supplied via terraform.tfvars or TF_VAR_r2_secret_access_key — never committed."
  type        = string
  sensitive   = true
}

# --- Email one-time-passcode login (SPEC-EMAIL-AUTH.md) ---
# login_code_hmac_key has no variable here — it's Terraform-generated
# (ssm.tf's random_id.login_code_hmac_key), the same "nothing external
# needs to know it" reasoning as db_password, rather than a human-supplied
# secret like the ones above.

variable "email_from_address" {
  description = "The `From:` address login-code emails are sent from (non-secret) — e.g. \"StrewthGif <login@strewthgif.example.com>\". Must be on a domain SES is verified for (see ses.tf)."
  type        = string
}

variable "turnstile_site_key" {
  description = "Cloudflare Turnstile site key (non-secret — exposed to the frontend via GET /api/config). The matching secret key is turnstile_secret_key below."
  type        = string
}

variable "turnstile_secret_key" {
  description = "Cloudflare Turnstile secret key (SPEC-EMAIL-AUTH.md §6). Supplied via terraform.tfvars or TF_VAR_turnstile_secret_key — never committed."
  type        = string
  sensitive   = true
}

variable "trust_cf_connecting_ip" {
  description = "Whether the origin accepts traffic exclusively from Cloudflare's IP ranges — only then is the CF-Connecting-IP header safe to trust for per-IP rate limiting (SPEC-EMAIL-AUTH.md §6)."
  type        = bool
  default     = false
}
