# Amazon Linux 2023 ships the SSM agent preinstalled — nothing to
# bootstrap for SSM access (see security_groups.tf: no SSH at all).
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
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
    docker_compose_yml        = file("${path.module}/../docker-compose.yml")
    deploy_sh                 = file("${path.module}/files/deploy.sh")
    rds_endpoint              = aws_db_instance.main.endpoint
    r2_account_id             = var.r2_account_id
    r2_bucket_name            = var.r2_bucket_name
    r2_public_base_url        = var.r2_public_base_url
    google_client_id          = var.google_client_id
    app_base_url              = "https://${var.domain_name}"
    source_videos_s3_bucket   = aws_s3_bucket.source_videos.bucket
    source_videos_s3_region   = var.aws_region
    template_assets_s3_bucket = aws_s3_bucket.template_assets.bucket
    template_assets_s3_region = var.aws_region
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
