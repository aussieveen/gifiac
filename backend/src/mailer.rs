//! Sends the email-passcode login code (SPEC-EMAIL-AUTH.md §7). A
//! concrete `Mailer` struct with an internal backend enum — the same
//! shape `Storage` (storage.rs) uses for its one real implementation,
//! rather than a `dyn`-dispatched trait: selection is a single `MAILER`
//! env var read once at startup, not something that varies per call or
//! needs runtime substitution, so a trait would only add a second
//! abstraction idiom to the codebase for no behavioral benefit.

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use aws_sdk_sesv2::Client as SesClient;
use aws_sdk_sesv2::types::{Body, Content, Destination, EmailContent, Message};

/// Every `(to, code)` pair a `MailerBackend::Capture` has sent.
type SentCodes = Arc<Mutex<Vec<(String, String)>>>;

/// `EMAIL_FROM_ADDRESS`/`SES_REGION` are only required when `MAILER=ses` —
/// see `EmailAuthConfig::from_env`.
#[derive(Clone)]
enum MailerBackend {
    Ses { client: SesClient, from_address: String },
    /// Local dev/test default — logs the plaintext code at INFO. The only
    /// place a plaintext code may ever appear in logs; never selected in
    /// production (`EmailAuthConfig::from_env` doesn't default here based
    /// on any production signal — the deploy's `MAILER` env var is what
    /// actually decides that).
    Log,
    /// Test-only in practice (never selected by `MAILER`, which is only
    /// ever `ses` or `log`) — records every send in memory instead of
    /// talking to SES or the log, so a test can assert on the exact code
    /// that was sent. Not `#[cfg(test)]`-gated: `backend/tests/common`
    /// builds `AppState` directly against the library as an ordinary
    /// dependency, where `cfg(test)` items aren't visible.
    Capture(SentCodes),
}

#[derive(Clone)]
pub struct Mailer {
    backend: MailerBackend,
}

impl Mailer {
    pub fn log() -> Self {
        Self { backend: MailerBackend::Log }
    }

    pub async fn ses(from_address: String, region: String) -> Self {
        let sdk_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_sdk_sesv2::config::Region::new(region))
            .load()
            .await;
        Self {
            backend: MailerBackend::Ses {
                client: SesClient::new(&sdk_config),
                from_address,
            },
        }
    }

    pub fn capture() -> (Self, SentCodes) {
        let sent: SentCodes = Arc::new(Mutex::new(Vec::new()));
        (Self { backend: MailerBackend::Capture(sent.clone()) }, sent)
    }

    /// Sends `code` (already the plaintext 6-digit code — never logged or
    /// transmitted anywhere except here and the recipient's inbox) to
    /// `to`. Content per SPEC-EMAIL-AUTH.md §7: no links, subject omits
    /// the code, plain-text and HTML parts both present.
    pub async fn send_login_code(&self, to: &str, code: &str) -> Result<()> {
        match &self.backend {
            MailerBackend::Log => {
                tracing::info!("login code for {to}: {code}");
                Ok(())
            }
            MailerBackend::Capture(sent) => {
                sent.lock().unwrap().push((to.to_string(), code.to_string()));
                Ok(())
            }
            MailerBackend::Ses { client, from_address } => {
                let subject = Content::builder().data("Your StrewthGif sign-in code").charset("UTF-8").build()?;
                let text = Content::builder().data(plain_text_body(code)).charset("UTF-8").build()?;
                let html = Content::builder().data(html_body(code)).charset("UTF-8").build()?;
                let body = Body::builder().text(text).html(html).build();
                let message = Message::builder().subject(subject).body(body).build();
                let destination = Destination::builder().to_addresses(to).build();
                client
                    .send_email()
                    .from_email_address(from_address)
                    .destination(destination)
                    .content(EmailContent::builder().simple(message).build())
                    .send()
                    .await
                    .context("sending login-code email via SES")?;
                Ok(())
            }
        }
    }
}

fn plain_text_body(code: &str) -> String {
    format!(
        "Here's your StrewthGif sign-in code:\n\n    {code}\n\n\
         This code expires in 10 minutes.\n\n\
         If you didn't request this, you can ignore this email. Nobody can sign in without the code.\n\n\
         — StrewthGif"
    )
}

fn html_body(code: &str) -> String {
    format!(
        "<div style=\"font-family:Helvetica,Arial,sans-serif;background:#f4f1e8;padding:32px\">\
         <div style=\"max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4dfcf\">\
         <div style=\"padding:32px\">\
         <p style=\"font-size:22px;font-weight:700;color:#111114;margin:0 0 18px\">Here's your sign-in code</p>\
         <p style=\"font-size:16px;color:#3a3b44;margin:0 0 18px\">Enter this code on StrewthGif to sign in:</p>\
         <div style=\"font-family:Menlo,Consolas,monospace;font-size:32px;letter-spacing:6px;text-align:center;\
         background:#fdf6d8;border:2px solid #f5c518;border-radius:8px;padding:16px 0;margin:0 0 18px\">{code}</div>\
         <p style=\"font-size:15px;color:#3a3b44;margin:0 0 8px\">This code expires in <b>10 minutes</b>.</p>\
         <p style=\"font-size:13px;color:#6c6d7a;margin:0\">If you didn't request this, you can ignore this email. \
         Nobody can sign in without the code.</p>\
         </div></div></div>"
    )
}
