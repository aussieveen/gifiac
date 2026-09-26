# Private source-video bucket (SPEC-CLOUD.md §6) — raw uploads only. The
# persistent, versioned template-clip bucket described in SPEC-CLOUD.md
# §10's Backup/DR section is defined further down this file
# (aws_s3_bucket.template_assets) — a deliberate scope cut when this
# bucket was first built (M3/M5d kept templates local-disk-only), closed
# once an EC2 instance replacement was found to actually lose every saved
# template for good.
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

# Persistent template-clip bucket (SPEC-CLOUD.md §10's Backup/DR section) —
# a saved template's clip/thumbnail/filmstrip (routes::videos::save_template)
# back themselves up here, closing the gap this bucket's own original scope
# cut left: those three files used to live only on the EC2 instance's own
# disk, meaning an instance replacement lost every saved template for good.
# A separate bucket from source_videos above, not a second prefix in it —
# the two buckets' lifecycle rules are opposites (hard 7-day delete vs.
# "keep forever, just prune old versions"), and keeping them physically
# separate means a future lifecycle-rule edit can't accidentally apply the
# wrong one to the wrong prefix.
resource "aws_s3_bucket" "template_assets" {
  bucket = "gifiac-template-assets-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "gifiac-template-assets"
  }
}

resource "aws_s3_bucket_public_access_block" "template_assets" {
  bucket = aws_s3_bucket.template_assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "template_assets" {
  bucket = aws_s3_bucket.template_assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioned (SPEC-CLOUD.md §10: "versioning enabled") — re-saving a
# template overwrites the same object keys (paths::template_clip_object_key
# derives from the template's own id), so this is what protects against an
# accidental bad overwrite, not just outright deletion.
resource "aws_s3_bucket_versioning" "template_assets" {
  bucket = aws_s3_bucket.template_assets.id

  versioning_configuration {
    status = "Enabled"
  }
}

# "with a lifecycle rule expiring noncurrent versions after 30 days to
# bound storage growth while keeping a rollback window" (SPEC-CLOUD.md
# §10, quoted directly) — current versions are never expired by this rule,
# only prior ones a template overwrite or delete left behind.
resource "aws_s3_bucket_lifecycle_configuration" "template_assets" {
  bucket = aws_s3_bucket.template_assets.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    # Empty filter — applies bucket-wide, not scoped to one prefix
    # (there's only ever the one kind of object in this bucket anyway).
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}
