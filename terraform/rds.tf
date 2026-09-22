resource "aws_db_subnet_group" "main" {
  name       = "gifiac"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "gifiac"
  }
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier     = "gifiac"
  engine         = "postgres"
  engine_version = "16"

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_encrypted = true

  db_name  = "gifiac"
  username = "gifiac"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  multi_az               = false
  publicly_accessible    = false

  backup_retention_period   = 7
  skip_final_snapshot       = false
  final_snapshot_identifier = "gifiac-final"

  tags = {
    Name = "gifiac"
  }
}
