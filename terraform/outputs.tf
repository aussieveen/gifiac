output "alb_dns_name" {
  description = "Point the domain's DNS (CNAME or ALIAS, wherever it's hosted) at this."
  value       = aws_lb.app.dns_name
}

output "acm_validation_records" {
  description = "DNS validation record(s) to add wherever the domain's DNS is hosted — required before ACM issues the certificate. See terraform/README.md for the two-phase apply this implies."
  value = [
    for o in aws_acm_certificate.app.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "rds_endpoint" {
  description = "RDS connection endpoint (host:port)."
  value       = aws_db_instance.main.endpoint
}

output "source_videos_bucket_name" {
  description = "The private S3 bucket name for SOURCE_VIDEOS_S3_BUCKET."
  value       = aws_s3_bucket.source_videos.bucket
}

output "github_deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN GitHub repo variable."
  value       = aws_iam_role.deploy.arn
}
