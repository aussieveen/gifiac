# Amazon Linux 2023 ships the SSM agent preinstalled — nothing to
# bootstrap for SSM access (see security_groups.tf: no SSH at all).
# arm64, not x86_64(COST-REDUCTION-PLAN.md step 3 — t4g.micro is
# Graviton/arm64; an x86_64 AMI simply fails to launch on a t4g instance
# type, architecture mismatch).
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Rendered once here (not inline in user_data.sh.tftpl) so the exact
# same content can be pushed to an *already-running* instance by
# `terraform_data.push_config_env` below, not just baked into a brand
# new one — see that resource's comment for why that second path is
# needed at all.
locals {
  config_env = templatefile("${path.module}/config.env.tftpl", {
    r2_account_id               = var.r2_account_id
    r2_bucket_name              = var.r2_bucket_name
    r2_public_base_url          = var.r2_public_base_url
    google_client_id            = var.google_client_id
    app_base_url                = "https://${var.domain_name}"
    source_videos_s3_bucket     = aws_s3_bucket.source_videos.bucket
    source_videos_s3_region     = var.aws_region
    template_assets_s3_bucket   = aws_s3_bucket.template_assets.bucket
    template_assets_s3_region   = var.aws_region
    email_from_address          = var.email_from_address
    ses_region                  = var.aws_region
    turnstile_site_key          = var.turnstile_site_key
    trust_cf_connecting_ip      = var.trust_cf_connecting_ip
    ingest_lambda_function_name = local.ingest_function_name
    export_lambda_function_name = local.export_function_name
    callback_base_url           = "https://${var.domain_name}"
  })
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.ec2.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name

  # user_data only ever matters at first boot (it writes deploy.sh,
  # docker-compose.yml, and config.env, then runs deploy.sh once) — every
  # later deploy.sh/docker-compose.yml edit reaches the running instance
  # through the GitHub Actions deploy job (SSM send-command), not through
  # user_data again. Without this, the AWS provider's default behavior
  # forces a full instance replacement on any user_data diff — silently
  # destroying the instance's root volume, and with it whatever hasn't
  # been backed up yet: template clips/thumbnails now do back up to S3
  # (aws_s3_bucket.template_assets, s3.tf), but the local disk cache of a
  # recently re-fetched raw source video, and any not-yet-clipped
  # in-progress edit, would still only exist there.
  user_data_replace_on_change = false

  root_block_device {
    volume_size = var.ec2_root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    docker_compose_yml = file("${path.module}/../docker-compose.yml")
    caddyfile          = file("${path.module}/../Caddyfile")
    deploy_sh          = file("${path.module}/files/deploy.sh")
    config_env         = local.config_env
  })

  # `data.aws_ami.al2023` re-resolves to whatever AMI is newest at plan
  # time, but `ami` is a ForceNew attribute on aws_instance — so an
  # ordinary `terraform apply` for an unrelated change (a new variable, a
  # security group tweak) can silently pick up a newer AMI and replace the
  # instance, destroying the root volume, exactly like the user_data case
  # above but without even a code diff to explain it. Once created, this
  # instance keeps its AMI; bump it deliberately (change the filter, or
  # `terraform apply -replace=aws_instance.app`) when you actually want to
  # move to a newer base image.
  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "gifiac"
  }
}

# So the deploy target and DNS record survive an instance stop/start
# without the address changing.
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Name = "gifiac"
  }
}

# `user_data` only ever runs once, at first boot — it's what the first
# gap in this file's history (`user_data_replace_on_change`) is about,
# and config.env has the exact same problem: an `apply` that changes
# `local.config_env` updates the *Terraform-tracked* `user_data`
# attribute, but never touches the file already sitting on a running
# instance. The instance has no SSH (security_groups.tf), only SSM, so
# this re-pushes the freshly-rendered content the same way via
# `send-command` whenever the rendered content actually changes
# (`triggers_replace`), then re-runs deploy.sh so the new values take
# effect immediately rather than silently waiting for some later,
# unrelated deploy to happen to restart the container.
resource "terraform_data" "push_config_env" {
  triggers_replace = [local.config_env]

  provisioner "local-exec" {
    # `base64encode()` runs in Terraform, not the shell — the rendered
    # config can contain characters (EMAIL_FROM_ADDRESS's "Name <addr>"
    # form has `<`/`>`, among others) that would be unsafe to interpolate
    # directly into a shell command string; a base64 blob has none of
    # that risk, matching the encode-in-Terraform-not-shell shape
    # docker-publish.yml's deploy job already uses for the same reason.
    command = <<-EOT
      set -euo pipefail
      config_b64="${base64encode(local.config_env)}"
      params="$(jq -n --arg config_b64 "$config_b64" '{commands: [
        "echo " + $config_b64 + " | base64 -d > /opt/gifiac/config.env",
        "chmod 600 /opt/gifiac/config.env",
        "bash /opt/gifiac/deploy.sh"
      ]}')"
      command_id=$(aws ssm send-command \
        --targets "Key=tag:Name,Values=gifiac" \
        --document-name "AWS-RunShellScript" \
        --parameters "$params" \
        --query "Command.CommandId" --output text)
      sleep 3
      instance_id=$(aws ssm list-command-invocations \
        --command-id "$command_id" \
        --query "CommandInvocations[0].InstanceId" --output text)
      for _ in $(seq 1 30); do
        status=$(aws ssm get-command-invocation \
          --command-id "$command_id" --instance-id "$instance_id" \
          --query "Status" --output text 2>/dev/null || echo "Pending")
        echo "config.env push status: $status"
        case "$status" in
          Success) exit 0 ;;
          Failed|Cancelled|TimedOut) exit 1 ;;
        esac
        sleep 5
      done
      echo "timed out waiting for config.env push to finish"
      exit 1
    EOT
  }

  depends_on = [aws_instance.app]
}
