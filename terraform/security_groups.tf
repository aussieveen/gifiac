resource "aws_security_group" "alb" {
  name        = "gifiac-alb"
  description = "Internet-facing ALB — HTTP/HTTPS from anywhere."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "gifiac-alb"
  }
}

# No port 22 — deploys and any interactive access go through SSM Session
# Manager / send-command (SPEC-CLOUD.md §10), not SSH.
resource "aws_security_group" "ec2" {
  name        = "gifiac-ec2"
  description = "gifiac app instance — app port from the ALB only, no SSH."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App port from the ALB"
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
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

resource "aws_security_group" "rds" {
  name        = "gifiac-rds"
  description = "gifiac RDS Postgres — from the app instance only."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from the app instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "gifiac-rds"
  }
}
