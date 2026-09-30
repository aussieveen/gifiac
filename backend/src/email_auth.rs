//! Email one-time-passcode login (SPEC-EMAIL-AUTH.md) — config loading,
//! rate-limit constants, email normalization, code generation/hashing, and
//! Turnstile verification. The HTTP handlers themselves live in
//! `routes::auth` alongside the Google OAuth ones they share a session
//! path with.

use anyhow::{Context, Result, bail};
use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Codes per email, cooldown between successive `/start` calls.
pub const RESEND_COOLDOWN_SECONDS: i64 = 60;
/// Codes per email, rolling hour.
pub const MAX_CODES_PER_EMAIL_PER_HOUR: i64 = 5;
/// Codes per IP, rolling hour.
pub const MAX_CODES_PER_IP_PER_HOUR: i64 = 20;
/// Verify attempts per code — the 6th attempt (whether right or wrong)
/// locks the code out.
pub const MAX_VERIFY_ATTEMPTS: i32 = 5;
/// Code lifetime.
pub const CODE_TTL_MINUTES: i64 = 10;

/// Required env vars, no defaults, mirroring `auth::GoogleAuthConfig`'s own
/// `from_env` shape — read once at startup, never exposed to the frontend
/// or logged (except `turnstile_site_key`, which is public by design and
/// served via `GET /api/config`).
#[derive(Debug, Clone)]
pub struct EmailAuthConfig {
    /// ≥32 random bytes, base64 — HMACs the plaintext code before it's
    /// stored (SPEC-EMAIL-AUTH.md §2). Terraform-generates this in
    /// production (`terraform/ssm.tf`); local dev sets it in `.env`.
    pub login_code_hmac_key: Vec<u8>,
    pub mailer_kind: MailerKind,
    pub email_from_address: Option<String>,
    pub ses_region: Option<String>,
    pub turnstile_secret_key: Option<String>,
    pub turnstile_site_key: Option<String>,
    pub trust_cf_connecting_ip: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailerKind {
    Ses,
    Log,
}

impl EmailAuthConfig {
    pub fn from_env() -> Result<Self> {
        let login_code_hmac_key_b64 = require_env("LOGIN_CODE_HMAC_KEY")?;
        let login_code_hmac_key = base64_decode(&login_code_hmac_key_b64).context("LOGIN_CODE_HMAC_KEY is not valid base64")?;
        if login_code_hmac_key.len() < 32 {
            bail!("LOGIN_CODE_HMAC_KEY must decode to at least 32 bytes");
        }

        let mailer_kind = match std::env::var("MAILER").ok().as_deref() {
            None | Some("log") | Some("") => MailerKind::Log,
            Some("ses") => MailerKind::Ses,
            Some(other) => bail!("invalid MAILER value {other:?} — expected \"ses\" or \"log\""),
        };
        let email_from_address = non_empty_env("EMAIL_FROM_ADDRESS");
        let ses_region = non_empty_env("SES_REGION");
        if mailer_kind == MailerKind::Ses && (email_from_address.is_none() || ses_region.is_none()) {
            bail!("MAILER=ses requires EMAIL_FROM_ADDRESS and SES_REGION to be set");
        }

        Ok(Self {
            login_code_hmac_key,
            mailer_kind,
            email_from_address,
            ses_region,
            turnstile_secret_key: non_empty_env("TURNSTILE_SECRET_KEY"),
            turnstile_site_key: non_empty_env("TURNSTILE_SITE_KEY"),
            trust_cf_connecting_ip: std::env::var("TRUST_CF_CONNECTING_IP").as_deref() == Ok("true"),
        })
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn require_env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

/// Minimal base64 (standard alphabet, with or without padding) — avoids
/// pulling in the `base64` crate for a single decode call at startup.
fn base64_decode(input: &str) -> Result<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let cleaned: Vec<u8> = input.bytes().filter(|b| *b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let mut buf = [0u8; 4];
        for (i, &b) in chunk.iter().enumerate() {
            let pos = ALPHABET.iter().position(|&a| a == b).context("invalid base64 character")?;
            buf[i] = pos as u8;
        }
        let n = ((buf[0] as u32) << 18) | ((buf[1] as u32) << 12) | ((buf[2] as u32) << 6) | (buf[3] as u32);
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// Trim + lowercase, per SPEC-EMAIL-AUTH.md §3 — deliberately does *not*
/// strip `+tag`s or Gmail dots, applied identically everywhere an email is
/// looked up or stored.
pub fn normalize_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// SPEC-EMAIL-AUTH.md §3: reject obviously malformed input before any
/// other work — no `@`, or over 254 chars.
pub fn is_plausible_email(email: &str) -> bool {
    email.contains('@') && email.len() <= 254 && !email.starts_with('@') && !email.ends_with('@')
}

/// Uniform CSPRNG 6-digit code, zero-padded, over `000000`-`999999`.
pub fn generate_code() -> String {
    let n: u32 = rand::rng().random_range(0..1_000_000);
    format!("{n:06}")
}

/// `HMAC-SHA256(LOGIN_CODE_HMAC_KEY, email + ":" + code)`, hex-encoded —
/// the plaintext code is never stored (SPEC-EMAIL-AUTH.md §2).
pub fn hash_code(hmac_key: &[u8], email: &str, code: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(hmac_key).expect("HMAC accepts any key length");
    mac.update(email.as_bytes());
    mac.update(b":");
    mac.update(code.as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

/// Constant-time comparison of the submitted code's HMAC against the
/// stored one — a naive `==` would leak timing information a 6-digit
/// code space can't afford.
pub fn code_matches(hmac_key: &[u8], email: &str, submitted_code: &str, stored_hash: &str) -> bool {
    let expected = hash_code(hmac_key, email, submitted_code);
    expected.as_bytes().ct_eq(stored_hash.as_bytes()).into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Cloudflare Turnstile server-side verification (SPEC-EMAIL-AUTH.md §6).
/// Only called when `secret_key` is `Some` — an unset key means local
/// dev/test, where the caller skips this entirely and logs a warning at
/// startup instead.
pub async fn verify_turnstile(http_client: &reqwest::Client, secret_key: &str, token: &str) -> Result<bool> {
    #[derive(serde::Deserialize)]
    struct TurnstileResponse {
        success: bool,
    }
    let response: TurnstileResponse = http_client
        .post("https://challenges.cloudflare.com/turnstile/v0/siteverify")
        .form(&[("secret", secret_key), ("response", token)])
        .send()
        .await
        .context("contacting Turnstile siteverify")?
        .json()
        .await
        .context("parsing Turnstile siteverify response")?;
    Ok(response.success)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_email_trims_and_lowercases() {
        assert_eq!(normalize_email("  Foo@Example.COM "), "foo@example.com");
    }

    #[test]
    fn normalize_email_does_not_strip_tags_or_dots() {
        assert_eq!(normalize_email("Foo+Tag@Example.com"), "foo+tag@example.com");
        assert_eq!(normalize_email("F.o.o@Example.com"), "f.o.o@example.com");
    }

    #[test]
    fn is_plausible_email_rejects_missing_at_and_oversized_input() {
        assert!(is_plausible_email("a@b.com"));
        assert!(!is_plausible_email("not-an-email"));
        assert!(!is_plausible_email(&format!("{}@b.com", "a".repeat(300))));
    }

    #[test]
    fn generate_code_is_six_zero_padded_digits() {
        for _ in 0..50 {
            let code = generate_code();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn code_matches_only_the_exact_code_that_was_hashed() {
        let key = b"01234567890123456789012345678901".to_vec();
        let hash = hash_code(&key, "a@example.com", "123456");
        assert!(code_matches(&key, "a@example.com", "123456", &hash));
        assert!(!code_matches(&key, "a@example.com", "654321", &hash));
        assert!(!code_matches(&key, "b@example.com", "123456", &hash));
    }

    #[test]
    fn base64_decode_round_trips_a_32_byte_key() {
        // `openssl rand -base64 32`-shaped input.
        let decoded = base64_decode("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=").unwrap();
        assert_eq!(decoded.len(), 32);
    }
}
