use std::path::Path;

use anyhow::{Context, Result};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;

/// R2 credentials/settings read from env vars at startup per SPEC.md §10 —
/// all required, no defaults (never exposed to the frontend or logged).
#[derive(Debug, Clone)]
pub struct R2Config {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket_name: String,
    pub public_base_url: String,
}

impl R2Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            account_id: require_env("R2_ACCOUNT_ID")?,
            access_key_id: require_env("R2_ACCESS_KEY_ID")?,
            secret_access_key: require_env("R2_SECRET_ACCESS_KEY")?,
            bucket_name: require_env("R2_BUCKET_NAME")?,
            public_base_url: require_env("R2_PUBLIC_BASE_URL")?,
        })
    }

    /// R2's S3-compatible API endpoint for this account.
    pub fn endpoint_url(&self) -> String {
        format!("https://{}.r2.cloudflarestorage.com", self.account_id)
    }
}

/// Credentials/settings for the private source-video S3 bucket
/// (SPEC-CLOUD.md §6). `access_key_id`/`secret_access_key` are optional —
/// set for local dev/test against MinIO (`Storage::new_for_source_bucket`
/// uses them directly when both are present); unset in production, where
/// SPEC-CLOUD.md §10 has the backend authenticate via the EC2 instance's
/// IAM role instead (the AWS SDK's own default credential provider chain,
/// which resolves that automatically). `endpoint_url_override` is
/// similarly MinIO-only; unset in production, where the endpoint is
/// derived from `region` instead.
#[derive(Debug, Clone)]
pub struct SourceStorageConfig {
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub bucket_name: String,
    pub region: String,
    pub endpoint_url_override: Option<String>,
}

impl SourceStorageConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            access_key_id: non_empty_env("SOURCE_VIDEOS_S3_ACCESS_KEY_ID"),
            secret_access_key: non_empty_env("SOURCE_VIDEOS_S3_SECRET_ACCESS_KEY"),
            bucket_name: require_env("SOURCE_VIDEOS_S3_BUCKET")?,
            region: require_env("SOURCE_VIDEOS_S3_REGION")?,
            endpoint_url_override: non_empty_env("SOURCE_VIDEOS_S3_ENDPOINT_URL"),
        })
    }
}

/// Credentials/settings for the private template-assets S3 bucket
/// (SPEC-CLOUD.md §10 — "persistent class", versioned) — a saved
/// template's clip/thumbnail/filmstrip (`routes::videos::save_template`),
/// durably backed up here instead of only ever living on the EC2
/// instance's own disk (which an instance replacement would otherwise
/// lose for good — there's no 7-day-window recovery path for these the
/// way there is for the ephemeral raw-video bucket, since a template is
/// meant to survive indefinitely). Same shape as `SourceStorageConfig` —
/// a separate type rather than reusing it, since that one's name/doc
/// comments are specific to the source-video bucket throughout this file.
#[derive(Debug, Clone)]
pub struct TemplateAssetsConfig {
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub bucket_name: String,
    pub region: String,
    pub endpoint_url_override: Option<String>,
}

impl TemplateAssetsConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            access_key_id: non_empty_env("TEMPLATE_ASSETS_S3_ACCESS_KEY_ID"),
            secret_access_key: non_empty_env("TEMPLATE_ASSETS_S3_SECRET_ACCESS_KEY"),
            bucket_name: require_env("TEMPLATE_ASSETS_S3_BUCKET")?,
            region: require_env("TEMPLATE_ASSETS_S3_REGION")?,
            endpoint_url_override: non_empty_env("TEMPLATE_ASSETS_S3_ENDPOINT_URL"),
        })
    }
}

/// Like `std::env::var(key).ok()`, but treats an empty string as absent
/// too — production's docker-compose `"${VAR}"` substitution sets the
/// container env var to `""` (not unset) when `.env` omits it, which is
/// exactly the deliberate case for these vars (falling back to the EC2
/// instance's IAM role, see `Storage::new_for_source_bucket`).
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn require_env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

/// Thin wrapper over the S3 SDK pointed at an S3-compatible endpoint
/// (`aws-sdk-s3` works against R2 via a custom endpoint override — no
/// separate R2 SDK, per SPEC.md §9). `endpoint_url` is a plain parameter
/// rather than always being derived from an `R2Config` so tests can point
/// this at a local MinIO instance instead of real R2. `public_base_url`
/// is `None` for a private bucket (the source-video bucket, SPEC-CLOUD.md
/// §6) that never derives a public URL from a key.
#[derive(Clone)]
pub struct Storage {
    client: Client,
    bucket: String,
    public_base_url: Option<String>,
}

impl Storage {
    pub fn new(
        endpoint_url: &str,
        bucket: &str,
        public_base_url: Option<&str>,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Self {
        let credentials = Credentials::new(access_key_id, secret_access_key, None, None, "gifiac");
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(credentials)
            .region(Region::new("auto"))
            .endpoint_url(endpoint_url)
            // R2 (and MinIO, for local testing) don't support DNS-style
            // virtual-hosted bucket addressing the way AWS S3 does.
            .force_path_style(true)
            .build();

        Self {
            client: Client::from_conf(config),
            bucket: bucket.to_string(),
            public_base_url: public_base_url.map(|url| url.trim_end_matches('/').to_string()),
        }
    }

    /// Builds a `Storage` for the private source-video bucket
    /// (SPEC-CLOUD.md §6) — always no `public_base_url` (nothing derives a
    /// public URL for a private bucket). Async, unlike `new`: resolving
    /// the AWS SDK's default credential provider chain can mean a network
    /// round-trip to the EC2 instance metadata service (IMDS) to fetch the
    /// instance role's temporary credentials.
    ///
    /// When `config` carries an explicit access key/secret (local dev/test
    /// against MinIO), those are used directly, exactly like `new` — the
    /// SDK's default chain is never consulted at all in that case. When
    /// they're absent (production), the default chain resolves credentials
    /// itself: environment variables, a shared credentials file, then the
    /// EC2 instance profile via IMDS — which is exactly the "backend
    /// authenticates via the same instance IAM role directly" SPEC-
    /// CLOUD.md §10 asks for, with no code path split needed between the
    /// two — only the *env vars set at deploy time* differ.
    pub async fn new_for_source_bucket(config: &SourceStorageConfig) -> Self {
        let mut loader = aws_config::defaults(BehaviorVersion::latest()).region(Region::new(config.region.clone()));
        if let (Some(access_key_id), Some(secret_access_key)) = (&config.access_key_id, &config.secret_access_key) {
            loader = loader.credentials_provider(Credentials::new(access_key_id, secret_access_key, None, None, "gifiac"));
        }
        let sdk_config = loader.load().await;

        let mut builder = aws_sdk_s3::config::Builder::from(&sdk_config);
        if let Some(endpoint_url) = &config.endpoint_url_override {
            // MinIO (local dev/test) — real S3 uses its normal
            // DNS-virtual-hosted addressing (the SDK's own default), so
            // this branch never applies in production.
            builder = builder.endpoint_url(endpoint_url).force_path_style(true);
        }

        Self {
            client: Client::from_conf(builder.build()),
            bucket: config.bucket_name.clone(),
            public_base_url: None,
        }
    }

    /// Identical shape/behavior to `new_for_source_bucket` — see its own
    /// doc comment — just for the template-assets bucket instead. Kept as
    /// its own method (rather than a shared generic helper) since the two
    /// configs are separate types with no shared trait, matching this
    /// file's existing R2Config/SourceStorageConfig split.
    pub async fn new_for_template_assets_bucket(config: &TemplateAssetsConfig) -> Self {
        let mut loader = aws_config::defaults(BehaviorVersion::latest()).region(Region::new(config.region.clone()));
        if let (Some(access_key_id), Some(secret_access_key)) = (&config.access_key_id, &config.secret_access_key) {
            loader = loader.credentials_provider(Credentials::new(access_key_id, secret_access_key, None, None, "gifiac"));
        }
        let sdk_config = loader.load().await;

        let mut builder = aws_sdk_s3::config::Builder::from(&sdk_config);
        if let Some(endpoint_url) = &config.endpoint_url_override {
            builder = builder.endpoint_url(endpoint_url).force_path_style(true);
        }

        Self {
            client: Client::from_conf(builder.build()),
            bucket: config.bucket_name.clone(),
            public_base_url: None,
        }
    }

    pub async fn upload_file(&self, key: &str, path: &Path, content_type: &str) -> Result<()> {
        let body = ByteStream::from_path(path)
            .await
            .with_context(|| format!("reading {}", path.display()))?;
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(body)
            .content_type(content_type)
            .send()
            .await
            .with_context(|| format!("uploading {key} to object storage"))?;
        Ok(())
    }

    /// Downloads `key` to `dest_path`, creating any missing parent
    /// directories. Buffers the whole object in memory before writing —
    /// fine for this app's size class (the same short-clip assumption
    /// already behind the 200MB upload cap).
    pub async fn download_file(&self, key: &str, dest_path: &Path) -> Result<()> {
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("downloading {key} from object storage"))?;
        let bytes = output
            .body
            .collect()
            .await
            .with_context(|| format!("reading {key} from object storage"))?
            .into_bytes();
        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(dest_path, &bytes)
            .await
            .with_context(|| format!("writing {} from object storage", dest_path.display()))?;
        Ok(())
    }

    pub async fn delete_object(&self, key: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("deleting {key} from object storage"))?;
        Ok(())
    }

    pub fn public_url(&self, key: &str) -> String {
        let base = self
            .public_base_url
            .as_deref()
            .expect("public_url called on a bucket with no public_base_url configured");
        format!("{base}/{key}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minio() -> Storage {
        Storage::new(
            "http://localhost:19000",
            "gifiac-test",
            Some("http://localhost:19000/gifiac-test"),
            "gifiac",
            "gifiac-test-secret",
        )
    }

    async fn minio_source_videos() -> Storage {
        Storage::new_for_source_bucket(&SourceStorageConfig {
            access_key_id: Some("gifiac".to_string()),
            secret_access_key: Some("gifiac-test-secret".to_string()),
            bucket_name: "gifiac-source-videos-test".to_string(),
            region: "us-east-1".to_string(),
            endpoint_url_override: Some("http://localhost:19000".to_string()),
        })
        .await
    }

    #[test]
    fn public_url_joins_base_and_key() {
        let storage = minio();
        assert_eq!(
            storage.public_url("gifs/abc.gif"),
            "http://localhost:19000/gifiac-test/gifs/abc.gif"
        );
    }

    #[test]
    fn public_url_tolerates_a_trailing_slash_on_the_base() {
        let storage = Storage::new(
            "http://localhost:19000",
            "b",
            Some("http://localhost:19000/gifiac-test/"),
            "a",
            "s",
        );
        assert_eq!(
            storage.public_url("x.gif"),
            "http://localhost:19000/gifiac-test/x.gif"
        );
    }

    #[tokio::test]
    #[should_panic(expected = "no public_base_url configured")]
    async fn public_url_panics_when_the_bucket_has_no_public_base_url() {
        minio_source_videos().await.public_url("raw/abc.mp4");
    }

    /// Exercises upload/delete against a real S3-compatible server (the
    /// local MinIO instance from `docker-compose.dev.yml`) rather than
    /// mocking the SDK, since the whole point of R2 integration is the
    /// wire format actually working. Ignored by default so `cargo test`
    /// doesn't require MinIO to be running; run explicitly with
    /// `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "requires a local MinIO instance on :19000"]
    async fn upload_then_delete_round_trips_against_minio() {
        let storage = minio();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("hello.txt");
        std::fs::write(&file_path, b"hello from gifiac").unwrap();

        storage
            .upload_file("test/hello.txt", &file_path, "text/plain")
            .await
            .unwrap();

        let url = storage.public_url("test/hello.txt");
        let body = reqwest::get(&url).await.unwrap().text().await.unwrap();
        assert_eq!(body, "hello from gifiac");

        storage.delete_object("test/hello.txt").await.unwrap();
    }

    /// Same "test against the real wire format" philosophy, for the
    /// private-bucket path — round-trips through `upload_file` +
    /// `download_file` since there's no public URL to fetch back through.
    #[tokio::test]
    #[ignore = "requires a local MinIO instance on :19000"]
    async fn upload_then_download_round_trips_against_minio() {
        let storage = minio_source_videos().await;
        let dir = tempfile::tempdir().unwrap();
        let source_path = dir.path().join("source.txt");
        std::fs::write(&source_path, b"hello from a private bucket").unwrap();

        storage
            .upload_file("test/private.txt", &source_path, "text/plain")
            .await
            .unwrap();

        let dest_path = dir.path().join("downloaded.txt");
        storage.download_file("test/private.txt", &dest_path).await.unwrap();
        assert_eq!(std::fs::read(&dest_path).unwrap(), b"hello from a private bucket");

        storage.delete_object("test/private.txt").await.unwrap();
    }
}
