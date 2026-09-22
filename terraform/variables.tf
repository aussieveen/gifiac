variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "eu-west-1"
}

variable "domain_name" {
  description = "Domain the app is served on. DNS is not hosted in Route53 (see terraform/README.md) — this only names the ACM certificate; the user points DNS at the ALB manually."
  type        = string
}

variable "github_repository" {
  description = "GitHub \"owner/repo\" allowed to assume the deploy role via OIDC."
  type        = string
  default     = "aussieveen/gifiac"
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
