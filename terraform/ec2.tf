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

  root_block_device {
    volume_size = var.ec2_root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    docker_compose_yml      = file("${path.module}/../docker-compose.yml")
    deploy_sh               = file("${path.module}/files/deploy.sh")
    rds_endpoint            = aws_db_instance.main.endpoint
    r2_account_id           = var.r2_account_id
    r2_bucket_name          = var.r2_bucket_name
    r2_public_base_url      = var.r2_public_base_url
    google_client_id        = var.google_client_id
    app_base_url            = "https://${var.domain_name}"
    source_videos_s3_bucket = aws_s3_bucket.source_videos.bucket
    source_videos_s3_region = var.aws_region
  })

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
