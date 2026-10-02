# AWS cost reduction plan

Current run rate (on-demand, eu-west-1, confirmed via AWS Pricing API):

| Resource | Cost/mo |
|---|---|
| EC2 `t3.medium` | ~$33.30 |
| ALB `gifiac` (incl. its 2 service-managed public IPs, one per AZ) | ~$16-20 |
| RDS `db.t4g.micro` (20GB) | ~$12-14 |
| EBS 40GB gp3 root volume | ~$3.52 |
| S3 / Route53 / misc | <$1 |
| **Total** | **~$65-70/mo** |

Target: $8-12/mo. Decided floor: **~$12.60/mo on-demand** (user declined Spot
pricing to avoid interruption risk):

| Resource | Cost/mo |
|---|---|
| EC2 `t4g.micro` (ARM, on-demand) | $6.72 |
| EBS 20GB gp3 root volume | $1.76 |
| 1 public IPv4 (unavoidable — AWS bills all public IPv4s since Feb 2024, attached or not) | $3.65 |
| S3 / Route53 / misc | ~$0.50 |
| **Total** | **~$12.60/mo** |

No ALB, no RDS.

**Correction:** an earlier pass of this plan listed the ALB's two
per-AZ public IPs (`40.180.22.0`, `52.49.227.86`) as "orphaned Elastic
IPs" to release as a standalone zero-risk win. That was wrong — they're
`ServiceManaged: alb`, i.e. owned by the load balancer itself (one per AZ
it spans), and AWS refuses a manual `release-address` on them
(`OperationNotPermitted`) while the ALB exists. There is no free-standing
EIP cleanup step; they go away automatically as part of Step 1 below when
the ALB is deleted. Their cost is already folded into the ALB line above,
not counted separately.

## Step 1 — drop the ALB, move TLS to Cloudflare + Caddy ✅ done (2026-10-02)

Verified end-to-end: DNS resolves to Cloudflare, Full (Strict) TLS
validates the Origin CA cert, `https://www.strewthgif.com/` returns 200
with `via: 1.1 Caddy`. ALB, its listeners, target group, and the ACM
cert are destroyed; `terraform plan` shows no drift.


Terraform changes:
- Delete `terraform/alb.tf` entirely (`aws_lb.app`, `aws_lb_target_group.app`,
  `aws_lb_target_group_attachment.app`, both listeners).
- Delete `terraform/acm.tf` (`aws_acm_certificate.app`) — TLS now terminates
  on the instance with a Cloudflare Origin CA cert instead of an AWS-issued one.
- `terraform/security_groups.tf`: delete `aws_security_group.alb`. Change
  `aws_security_group.ec2` to accept 443 (and optionally 80, for the
  ACME-less redirect) directly, scoped to Cloudflare's published IP ranges
  instead of the ALB security group — matches the existing
  `trust_cf_connecting_ip` variable's assumption that Cloudflare already sits
  in front.
- `terraform/outputs.tf`: remove `alb_dns_name`, `acm_validation_records`,
  `acm_certificate_arn`.

App/instance changes:
- Add a `caddy` (or `nginx`) container to `docker-compose.yml`, listening on
  443, proxying to `gifiac:8080`, using a Cloudflare Origin CA certificate
  (15-year validity, issued free from the Cloudflare dashboard — SSL/TLS →
  Origin Server). Set Cloudflare's SSL mode to **Full (Strict)**.
- In Cloudflare DNS, turn the proxy status to orange-cloud (proxied) for
  `www.strewthgif.com`, pointed at the instance's Elastic IP — replacing
  today's "point DNS at the ALB" step.

## Step 2 — drop RDS, run Postgres on the instance

Terraform changes:
- Delete `terraform/rds.tf` (`aws_db_subnet_group.main`, `random_password.db`,
  `aws_db_instance.main`) and the now-unused private subnets in
  `network.tf` (`aws_subnet.private`) if nothing else uses them.
- `terraform/security_groups.tf`: delete `aws_security_group.rds`.
- `terraform/ec2.tf`: the `rds_endpoint` templatefile var goes away;
  `DATABASE_URL` now points at `localhost` (or the compose service name).
- `terraform/ssm.tf` / `files/deploy.sh`: `db_password` SSM param and the
  `DB_PASSWORD` fetch can go — Postgres's credentials become local-only,
  no longer need to be secret-managed across instance replacement.

App/instance changes:
- Add a `postgres:16` container to `docker-compose.yml` with a named volume
  (`/opt/gifiac/data/postgres:/var/lib/postgresql/data`, same disk the app
  data already lives on).
- Add a cron job (or a sidecar container) doing nightly `pg_dump | gzip` to
  the existing `template_assets` S3 bucket, since RDS's managed
  backups/PITR go away.

**Migration order (avoid data loss):**
1. Stand up the new `postgres` container empty, confirm it starts.
2. `pg_dump` the live RDS database, `pg_restore`/`psql` it into the new
   container.
3. Flip `DATABASE_URL` in `deploy.sh`'s rendered `.env` to the local
   container, redeploy, verify the app works end-to-end against local PG.
4. Only after verifying reads/writes land correctly, take a final RDS
   snapshot (`skip_final_snapshot = false` already does this on destroy)
   and `terraform apply` the RDS removal.

## Step 3 — right-size EC2 to `t4g.micro` (ARM)

This is the one with the most moving parts since it's an architecture
change (x86_64 → aarch64), not just a terraform edit:

- `.github/workflows/docker-publish.yml`: change
  `platforms: linux/amd64` → `platforms: linux/amd64,linux/arm64` (keep
  amd64 too, cheap with buildx cache, in case of rollback to an x86
  instance). All three Dockerfile base images (`node:22-slim`,
  `rust:1-slim-bookworm`, `debian:bookworm-slim`) ship official arm64
  manifests, and `ffmpeg` is available via `apt` on arm64 Debian bookworm,
  so no source changes expected — just slower CI (QEMU or native arm64
  runner).
- `terraform/user_data.sh.tftpl`: the Docker Compose plugin download is
  hardcoded to `docker-compose-linux-x86_64` — change to resolve `uname -m`
  (`x86_64` → `x86_64`, `aarch64` → `aarch64`) or just hardcode
  `docker-compose-linux-aarch64` once committed to Graviton.
- `terraform/variables.tf`: `instance_type` default → `t4g.micro`.
- Add a swap file in `user_data.sh.tftpl` (e.g. 2GB on the EBS root volume)
  as an OOM safety net — `t4g.micro` has only 1GiB RAM and the existing
  code comment on `instance_type` already flags transcoding as
  memory-hungry even on `t3.micro` (1GiB too, but x86).
- This forces instance replacement (AMI stays the same family but
  `instance_type` change doesn't need `-replace`; just changes the running
  instance type — no data loss, brief restart).

Watch one real risk here: if an export genuinely needs more than ~1GiB +
swap, `t4g.micro` will be too tight. Test with your largest real-world
clip before committing to this size; `t4g.small` ($13.43/mo) is the
fallback if `t4g.micro` OOMs under load, which would put the total around
$19/mo instead of $12.60.

## Suggested order

Step 1 (ALB→Cloudflare, no data risk, test HTTPS works end-to-end) →
Step 2 (RDS→local Postgres, the one with actual data-loss risk, needs the
dump/restore/verify sequence above) → Step 3 (EC2 resize + arch switch,
test ffmpeg memory headroom before committing). Each step is
independently revertible via `git revert` + `terraform apply` until Step
2's final RDS destroy, which is the only irreversible one.
