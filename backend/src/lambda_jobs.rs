//! Invokes the ingest/export Lambda functions (wayfinder gifiac#32) —
//! the backend's half of the contract `bin/ingest_lambda.rs`/
//! `bin/export_lambda.rs` implement. Always async invocation
//! (`InvocationType::Event`, fire-and-forget): the backend never waits on
//! a Lambda call directly, it only creates the DB job row and relays
//! progress once the Lambda's callback arrives (`routes::internal`).

use anyhow::{Context, Result};
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;
use uuid::Uuid;

use crate::models::ExportFormat;
use crate::state::AppState;

pub struct LambdaConfig {
    pub ingest_function_name: String,
    pub export_function_name: String,
    /// This backend's own public base URL — the ingest/export Lambdas
    /// POST their callbacks to `{callback_base_url}/api/internal/callbacks/*`.
    pub callback_base_url: String,
    /// Shared secret the callback endpoints check for (bearer token) —
    /// Lambda has no user session, so this is the only auth on those
    /// routes (see `routes::internal::verify_callback_token`).
    pub callback_token: String,
}

impl LambdaConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            ingest_function_name: require_env("INGEST_LAMBDA_FUNCTION_NAME")?,
            export_function_name: require_env("EXPORT_LAMBDA_FUNCTION_NAME")?,
            callback_base_url: require_env("CALLBACK_BASE_URL")?,
            callback_token: require_env("LAMBDA_CALLBACK_TOKEN")?,
        })
    }
}

fn require_env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

pub async fn invoke_ingest(state: &AppState, job_id: Uuid, video_id: Uuid, source_key: &str, extension: &str) -> Result<()> {
    let payload = serde_json::json!({
        "job_id": job_id.to_string(),
        "video_id": video_id.to_string(),
        "source_key": source_key,
        "extension": extension,
        "callback_url": ingest_callback_url(state),
        "callback_token": state.lambda_config.callback_token,
    });
    invoke(state, &state.lambda_config.ingest_function_name, &payload).await
}

#[allow(clippy::too_many_arguments)]
pub async fn invoke_export(
    state: &AppState,
    job_id: Uuid,
    format: ExportFormat,
    source_key: &str,
    ass_content: &str,
    range_start: f64,
    clip_duration: f64,
    output_key: &str,
) -> Result<()> {
    let payload = serde_json::json!({
        "job_id": job_id.to_string(),
        "format": format.as_str(),
        "source_key": source_key,
        "ass_content": ass_content,
        "range_start": range_start,
        "clip_duration": clip_duration,
        "output_key": output_key,
        "callback_url": export_callback_url(state),
        "callback_token": state.lambda_config.callback_token,
    });
    invoke(state, &state.lambda_config.export_function_name, &payload).await
}

pub fn ingest_callback_url(state: &AppState) -> String {
    format!("{}/api/internal/callbacks/ingest", state.lambda_config.callback_base_url)
}

pub fn export_callback_url(state: &AppState) -> String {
    format!("{}/api/internal/callbacks/export", state.lambda_config.callback_base_url)
}

async fn invoke(state: &AppState, function_name: &str, payload: &serde_json::Value) -> Result<()> {
    state
        .lambda_client
        .invoke()
        .function_name(function_name)
        .invocation_type(InvocationType::Event)
        .payload(Blob::new(serde_json::to_vec(payload)?))
        .send()
        .await
        .with_context(|| format!("invoking lambda function {function_name}"))?;
    Ok(())
}
