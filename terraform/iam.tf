# --- EC2 instance role ---
# AmazonSSMManagedInstanceCore is required for the SSM agent to register at
# all (deploys and interactive access both go through SSM, not SSH — see
# security_groups.tf). The inline policy adds only what the app itself
# needs: reading its own SSM parameters and talking to the source-video
# bucket via the SDK default credential chain (SPEC-CLOUD.md §10).
resource "aws_iam_role" "ec2" {
  name = "gifiac-ec2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ec2_ssm_core" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "ec2_app" {
  name = "gifiac-ec2-app"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSsmParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameters", "ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/gifiac/*"
      },
      {
        Sid    = "SourceVideoBucket"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.source_videos.arn,
          "${aws_s3_bucket.source_videos.arn}/*",
        ]
      },
    ]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name = "gifiac-ec2"
  role = aws_iam_role.ec2.name
}

data "aws_caller_identity" "current" {}

# --- GitHub Actions OIDC deploy role ---
#
# CAVEAT: an AWS account can only have one OIDC provider per URL. If this
# account already has a provider for token.actions.githubusercontent.com
# (from another project), comment out aws_iam_openid_connect_provider.github
# below and point aws_iam_role.deploy's trust policy at the existing
# provider's ARN instead — see terraform/README.md.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "deploy" {
  name = "gifiac-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      # aws-actions/configure-aws-credentials@v4 tags the assumed session
      # (repo/branch/actor, for audit trails) by default unless
      # role-skip-session-tagging is set — AWS requires sts:TagSession to
      # be trusted alongside AssumeRoleWithWebIdentity for that, or STS
      # rejects the whole call with a generic "not authorized" error that
      # gives no hint it was the missing tagging permission.
      Action = ["sts:AssumeRoleWithWebIdentity", "sts:TagSession"]
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          # Overridable — see github_oidc_subject's description for why
          # the plain "owner/repo" form isn't always what's actually in
          # the token's sub claim.
          "token.actions.githubusercontent.com:sub" = coalesce(var.github_oidc_subject, "repo:${var.github_repository}:ref:refs/heads/main")
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "gifiac-deploy"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SendDeployCommand"
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          aws_instance.app.arn,
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
        ]
      },
      {
        # Neither action supports resource-level restriction (AWS only
        # accepts "*" for both) — polling for the deploy command's result
        # and resolving which instance it ran on, nothing else, is all the
        # deploy role can do.
        Sid      = "PollDeployResult"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
        Resource = "*"
      },
    ]
  })
}
