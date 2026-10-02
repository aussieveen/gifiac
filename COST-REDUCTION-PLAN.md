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

Current run rate after steps 1 and 2 (no ALB, no RDS — EC2 still
`t3.medium` pending step 3):

| Resource | Cost/mo |
|---|---|
| EC2 `t3.medium` | ~$33.30 |
| EBS 40GB gp3 root volume | ~$3.52 |
| 1 public IPv4 | ~$3.65 |
| S3 / Route53 / misc | <$1 |
| **Total** | **~$41.50/mo** |

Already down from ~$65-70/mo to ~$41.50/mo. Step 3 (EC2 resize) is what
gets this to the final target.

Target: $8-12/mo. Decided floor, on-demand (user declined Spot pricing to
avoid interruption risk) — **~$14.37/mo actual**, slightly above the
original ~$12.60/mo estimate because the EBS volume stayed at 40GB
rather than shrinking to 20GB (see step 3 below for why):

| Resource | Cost/mo |
|---|---|
| EC2 `t4g.micro` (ARM, on-demand) | $6.72 |
| EBS 40GB gp3 root volume | $3.52 |
| 1 public IPv4 (unavoidable — AWS bills all public IPv4s since Feb 2024, attached or not) | $3.65 |
| S3 / Route53 / misc | ~$0.50 |
| **Total** | **~$14.37/mo** |

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

## Step 2 — drop RDS, run Postgres on the instance ✅ done (2026-10-02)

Executed as three safe sub-phases rather than one shot: (1) local
`postgres:16-alpine` container + nightly `pg_dump`-to-S3 systemd timer
stood up alongside RDS, app still pointed at RDS; (2) data copied via
`pg_dump | psql` run on the instance (RDS isn't publicly reachable) and
row counts verified identical across all 10 tables; (3) `DATABASE_URL`
flipped to the local container, verified end-to-end on the live
domain, then RDS destroyed (final snapshot `gifiac-final` taken
automatically, plus 7 days of prior automated snapshots still exist).
A manual pre-migration backup was also run and verified (valid gzip,
correct `COPY` count) before the destroy, on top of RDS's own
snapshot. `random_password.db`, `/gifiac/db_password`, the `rds`
security group, the private subnets, and the `db_instance_class`/
`db_allocated_storage` variables were all removed as dead config.


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

## Step 3 — right-size EC2 to `t4g.micro` (ARM) ✅ done (2026-10-02)

Executed as: (1) multi-arch Docker build — first attempt used a single
buildx call with `platforms: linux/amd64,linux/arm64` under QEMU
emulation, which made the arm64 leg effectively never finish
(`ffmpeg-sys-next`'s clang/bindgen step emulates terribly; cancelled
after over an hour stuck on it). Fixed by switching to a build-matrix
pattern: each arch builds **natively** (arm64 on GitHub's free
`ubuntu-24.04-arm` runner — this repo is public — amd64 on the usual
runner), pushed by digest, then merged into one multi-arch manifest.
Hit one bug along the way: the merge step's `imagetools create` used
metadata-action's `.json` output (full of embedded double quotes)
inside a double-quoted bash heredoc, breaking the quoting; fixed by
switching to the plain newline-separated `.tags` output. (2) AMI
filter switched to arm64, `instance_type` default → `t4g.micro`,
Docker Compose plugin download made arch-aware (`uname -m` happens to
match docker/compose's own release-asset naming exactly), 2GiB swap
file added as an OOM safety net. (3) Took a fresh Postgres backup,
ran `terraform apply` (replaced the instance — EIP reassociated
automatically, same public IP, no DNS change needed), then restored
the backup into the new empty Postgres container.

**The restore needed a second pass.** The first attempt lost every
row in a foreign-key-referencing table (`favourites`, `gifs`,
`identities`, `sessions`, `templates`, `user_preferences` all came
back empty) — `users`/`videos` loaded fine. Cause: unlike step 2's
migration (restoring into a genuinely empty database), this time the
app's own `sqlx` migrations had already created the full schema
*with FK constraints active* the moment the fresh containers booted,
before the restore ran. `pg_dump`'s plain-SQL `COPY` statements load
in alphabetical table order, which isn't FK-dependency order — most
child tables sort before `users` alphabetically, so their `COPY`
hit a live FK constraint against an empty parent table and silently
no-opped. Fixed by truncating the partial data and re-running the
restore wrapped in `SET session_replication_role = replica` (defers
FK checks for that session) — row counts matched exactly on the
second attempt, verified against the pre-replacement dump.

EBS stayed at 40GB rather than shrinking to the originally-planned
20GB — Postgres's data now also lives on this disk (step 2) on top of
the original "Docker images + video cache" sizing reasoning, and
actual usage (6GB/40GB) didn't make a strong case for the ~$1.76/mo
difference being worth the resize risk. This is why the final total
landed at ~$14.37/mo rather than the original ~$12.60/mo estimate.

**Resolved:** real ffmpeg export tested on `t4g.micro`. No OOM kills
(checked `dmesg`/kernel journal) — swap usage rose from a ~63MB
baseline to ~191MB during the export, confirming the 2GB swap file is
doing real work rather than sitting idle. Noticeably slower than
`t3.medium` was, which tracks: this is memory pressure being absorbed
by swap instead of crashing, not a free lunch. Acceptable tradeoff for
a personal project; `t4g.small` ($13.43/mo, ~$21/mo total) remains the
fallback if a heavier export ever does OOM.

## Suggested order

All three steps are done, applied in order: Step 1 (ALB→Cloudflare) →
Step 2 (RDS→local Postgres) → Step 3 (EC2 resize + arch switch). Final
run rate: **~$14.37/mo**, down from ~$65-70/mo.
