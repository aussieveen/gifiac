# gifiac AWS infrastructure

Provisions SPEC-CLOUD.md §10's target shape: one EC2 instance behind an
ALB (TLS via ACM), RDS Postgres, a private S3 bucket for raw video
uploads, SSM Parameter Store for secrets, and a GitHub-OIDC deploy role.

This is real, billed AWS infrastructure — `terraform apply` is a step
only you should run, with your own AWS credentials.

## One-time setup

1. Configure AWS credentials for the target account (e.g. `aws configure`
   or `AWS_PROFILE`), region doesn't matter here — `variables.tf` defaults
   `aws_region` to `eu-west-1`.
2. Create `terraform/terraform.tfvars` (already gitignored — never commit
   it) with the values Terraform can't know on its own:

   ```hcl
   domain_name           = "gifiac.example.com"
   google_client_id      = "..."
   google_client_secret  = "..."
   r2_account_id         = "..."
   r2_access_key_id      = "..."
   r2_secret_access_key  = "..."
   r2_bucket_name        = "..."
   r2_public_base_url    = "https://..."
   ```

3. `terraform init`

## GitHub OIDC provider — already-exists caveat

An AWS account can only have **one** OIDC provider per URL. If this
account already has a provider for
`token.actions.githubusercontent.com` (e.g. from another project),
`aws_iam_openid_connect_provider.github` in `iam.tf` will fail to
create. Fix:

1. Comment out the `aws_iam_openid_connect_provider "github"` resource
   in `iam.tf`.
2. In `aws_iam_role.deploy`'s trust policy, replace
   `aws_iam_openid_connect_provider.github.arn` with the existing
   provider's ARN (`aws iam list-open-id-connect-providers`).

## Applying — two phases, because of ACM DNS validation

The domain's DNS isn't in Route53 (it lives elsewhere — Cloudflare,
Namecheap, etc.), so this can't auto-validate the ACM certificate the
way a Route53-hosted domain could. That makes `apply` two-phase:

1. `terraform apply` — creates everything, including the ACM
   certificate (still `PENDING_VALIDATION`) and the ALB's HTTPS
   listener (which references the cert by ARN — this works immediately,
   it just won't actually serve HTTPS until the cert is issued).
2. Read the validation record(s) from the output:
   `terraform output acm_validation_records`. Add each as a CNAME record
   wherever the domain's DNS is actually hosted.
3. Wait for DNS propagation, then confirm in the AWS Console (Certificate
   Manager) that the certificate status is `ISSUED`. No second `apply` is
   actually required at this point — the listener already points at the
   cert's ARN and just starts working once ACM finishes issuing it.

## After applying

- Point the domain's DNS (an ALIAS or CNAME, again wherever DNS is
  hosted) at `terraform output alb_dns_name`.
- Set `AWS_DEPLOY_ROLE_ARN` as a **GitHub repository variable** (not a
  secret — it's not sensitive) to `terraform output github_deploy_role_arn`.
  This is the one step Terraform can't do itself without a separate
  GitHub provider/PAT, not worth adding for a single value.
- The instance runs `deploy.sh` once at first boot (via user-data), so it
  should already be serving. Future pushes to `main` trigger the
  `deploy` job in `.github/workflows/docker-publish.yml`, which re-runs
  the same `/opt/gifiac/deploy.sh` on the instance via SSM
  `send-command` — it re-fetches secrets from SSM and does
  `docker compose pull && up -d` each time.

## Verification without applying

`terraform fmt -check -recursive` and `terraform validate` check syntax
and internal consistency without touching AWS at all — safe to run
anytime, including with no credentials configured.
