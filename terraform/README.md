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
2. If you have other AWS profiles configured on this machine (e.g. a work
   account) and want a hard guardrail against applying to the wrong one,
   set `expected_aws_account_id` too — see `account_guard.tf`.
3. Create `terraform/terraform.tfvars` (already gitignored — never commit
   it) with the values Terraform can't know on its own:

   ```hcl
   domain_name              = "gifiac.example.com"
   google_client_id         = "..."
   google_client_secret     = "..."
   r2_account_id            = "..."
   r2_access_key_id         = "..."
   r2_secret_access_key     = "..."
   r2_bucket_name           = "..."
   r2_public_base_url       = "https://..."
   # aws_profile             = "personal"       # optional, see versions.tf
   # expected_aws_account_id = "123456789012"   # optional, see account_guard.tf
   ```

4. `terraform init`

## GitHub OIDC provider — already-exists caveat

An AWS account can only have **one** OIDC provider per URL. If this
account already has a provider for `token.actions.githubusercontent.com`
(e.g. from another project), `aws_iam_openid_connect_provider.github` in
`iam.tf` fails to create with `EntityAlreadyExists`. Fix by importing the
existing one instead of creating a new one — no code changes needed:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
terraform import aws_iam_openid_connect_provider.github \
  "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
```

Then `terraform plan` — `client_id_list`/`thumbprint_list` here are the
standard values every GitHub Actions OIDC setup uses, so this should show
no diff. If it does show one, stop and check what the existing provider
is actually configured for before applying — some other project may
depend on it.

## Applying — two phases, because of ACM DNS validation

The domain's DNS isn't in Route53 (it lives elsewhere — Cloudflare,
Namecheap, etc.), so this can't auto-validate the ACM certificate the
way a Route53-hosted domain could. That makes `apply` genuinely two-phase
— **the first `apply` is expected to fail**, not just proceed quietly:

1. `terraform apply` — creates everything else successfully (VPC, EC2,
   RDS, S3, the ALB itself, the HTTP→HTTPS redirect listener...), but
   fails on `aws_lb_listener.https` with `UnsupportedCertificate`. This
   is expected, not a bug to work around: ALB's `CreateListener` API
   rejects a certificate that isn't yet `ISSUED`, and DNS validation
   hasn't happened yet at this point. Everything that *did* succeed is
   now tracked in state — the second `apply` below won't recreate any
   of it.
2. Read the validation record(s) from the output:
   `terraform output acm_validation_records`. Add each as a CNAME record
   wherever the domain's DNS is actually hosted.
3. Wait for DNS propagation, then confirm the certificate status is
   `ISSUED` — either in the AWS Console (Certificate Manager) or:
   ```bash
   aws acm describe-certificate --region eu-west-1 \
     --certificate-arn "$(terraform output -raw acm_certificate_arn)" \
     --query 'Certificate.Status' --output text
   ```
4. Re-run `terraform apply`. With the cert now issued, `aws_lb_listener.https`
   creates successfully this time; everything else is already in state
   so nothing gets touched twice.

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

## Rotating a secret (`google_client_secret`, `r2_access_key_id`, etc.)

Updating `terraform.tfvars` and running `apply` only writes the new value
into SSM Parameter Store — it does **not** touch the running container.
The instance's `.env` (and thus the running app) still has whatever value
was baked in the last time `deploy.sh` actually ran, so a rotated secret
silently goes stale until something re-runs it. After `apply`, either:

```bash
# On the instance, via an SSM session:
sudo bash /opt/gifiac/deploy.sh
```

or push a trivial commit to `main` to let the GitHub Actions `deploy` job
do the same thing. `apply` alone is not enough.

## Verification without applying

`terraform fmt -check -recursive` and `terraform validate` check syntax
and internal consistency without touching AWS at all — safe to run
anytime, including with no credentials configured.
