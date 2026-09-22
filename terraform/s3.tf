# Private source-video bucket (SPEC-CLOUD.md §6) — raw uploads only. The
# persistent, versioned template-clip bucket described in SPEC-CLOUD.md
# §10's Backup/DR section is a deliberate scope cut: the app doesn't write
# template clips to S3 yet (M3/M5d kept them local-disk-only), so there's
# nothing for that bucket to hold. It lands whenever that migration is
# scheduled.
resource "aws_s3_bucket" "source_videos" {
  # S3 bucket names are globally unique across all AWS accounts — the
  # account ID suffix guarantees this one won't collide with someone
  # else's "gifiac-source-videos".
  bucket = "gifiac-source-videos-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "gifiac-source-videos"
  }
}

resource "aws_s3_bucket_public_access_block" "source_videos" {
  bucket = aws_s3_bucket.source_videos.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "source_videos" {
  bucket = aws_s3_bucket.source_videos.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Raw uploads auto-delete after 7 days regardless of whether a gif/template
# was made from them (SPEC-CLOUD.md §6) — matches paths::video_object_key's
# "raw/{id}.{ext}" convention exactly, so no app-side key changes needed.
# No versioning — ephemeral by design, trivially re-uploadable
# (SPEC-CLOUD.md §10, Backup/DR).
resource "aws_s3_bucket_lifecycle_configuration" "source_videos" {
  bucket = aws_s3_bucket.source_videos.id

  rule {
    id     = "expire-raw-uploads"
    status = "Enabled"

    filter {
      prefix = "raw/"
    }

    expiration {
      days = 7
    }
  }
}
