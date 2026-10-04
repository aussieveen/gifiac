# Ingest/export Lambda functions (wayfinder gifiac#32) — container-image
# functions built from Dockerfile.lambda (piece 2), invoked directly by
# the EC2 app via the AWS SDK (piece 3). arm64 throughout, matching the
# EC2 instance's own Graviton architecture and avoiding a second
# cross-compile target.

resource "aws_ecr_repository" "ingest_lambda" {
  name                 = "gifiac-ingest-lambda"
  image_tag_mutability = "MUTABLE"
}

resource "aws_ecr_repository" "export_lambda" {
  name                 = "gifiac-export-lambda"
  image_tag_mutability = "MUTABLE"
}

resource "aws_iam_role" "lambda_exec" {
  name = "gifiac-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_exec_basic_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Both functions read/write the source-video bucket directly (ingest
# downloads the raw upload and writes back the thumbnail/filmstrip;
# export downloads the source clip) — one shared role, one policy. R2
# access is not an IAM policy: R2 isn't a real AWS resource IAM can scope,
# so export_lambda's R2 credentials are passed as plain env vars below,
# the same explicit-credentials path the EC2 app already uses for R2
# (`Storage::new`).
resource "aws_iam_role_policy" "lambda_source_videos" {
  name = "gifiac-lambda-source-videos"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "SourceVideoBucket"
      Effect = "Allow"
      Action = ["s3:GetObject", "s3:PutObject"]
      Resource = [
        "${aws_s3_bucket.source_videos.arn}/*",
      ]
    }]
  })
}

resource "aws_lambda_function" "ingest" {
  function_name = "gifiac-ingest"
  role          = aws_iam_role.lambda_exec.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.ingest_lambda.repository_url}:latest"
  architectures = ["arm64"]
  # Sizing per gifiac#34: probe + thumbnail + filmstrip, lighter than the
  # 3-format export encode below.
  memory_size = 1024
  timeout     = 90

  environment {
    variables = {
      SOURCE_VIDEOS_S3_BUCKET = aws_s3_bucket.source_videos.bucket
      SOURCE_VIDEOS_S3_REGION = var.aws_region
    }
  }

  # Terraform has no way to know the real image was pushed by CI before
  # this first apply — ECR starts out empty, which would otherwise make
  # `terraform apply` fail trying to create the function against a
  # nonexistent `:latest` tag. `lambda-publish.yml` pushes the real image
  # and calls `aws lambda update-function-code` itself on every deploy;
  # Terraform never updates the image after this first creation.
  lifecycle {
    ignore_changes = [image_uri]
  }
}

resource "aws_lambda_function" "export" {
  function_name = "gifiac-export"
  role          = aws_iam_role.lambda_exec.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.export_lambda.repository_url}:latest"
  architectures = ["arm64"]
  # Sizing per gifiac#34: one format (gif/mp4/webm, chosen per invocation
  # via the `format` field in the invoke payload) per invocation, sharing
  # this one function.
  memory_size = 1536
  timeout     = 300

  ephemeral_storage {
    size = 2048
  }

  environment {
    variables = {
      SOURCE_VIDEOS_S3_BUCKET = aws_s3_bucket.source_videos.bucket
      SOURCE_VIDEOS_S3_REGION = var.aws_region
      R2_ACCOUNT_ID           = var.r2_account_id
      R2_ACCESS_KEY_ID        = var.r2_access_key_id
      R2_SECRET_ACCESS_KEY    = var.r2_secret_access_key
      R2_BUCKET_NAME          = var.r2_bucket_name
      R2_PUBLIC_BASE_URL      = var.r2_public_base_url
    }
  }

  lifecycle {
    ignore_changes = [image_uri]
  }
}

# Lets the EC2 app's existing instance role invoke both functions
# asynchronously (`InvocationType::Event`, piece 3's `lambda_jobs.rs`) —
# a separate resource rather than folding into iam.tf's `ec2_app` policy,
# since this one concern (invoking Lambda) belongs with the functions it
# invokes, not the app's S3/SES grants.
resource "aws_iam_role_policy" "ec2_invoke_lambda" {
  name = "gifiac-ec2-invoke-lambda"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeIngestExportLambdas"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.ingest.arn, aws_lambda_function.export.arn]
    }]
  })
}
