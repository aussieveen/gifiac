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

/// "070372" -> "070 372" — a bare 6-digit run is hard to read/copy at a
/// glance; splitting it into the two groups the design shows (and the
/// code-entry screen itself visually groups into) matches what the
/// recipient is about to type. `code` is always exactly 6 digits
/// (email_auth::generate_code), so a fixed split point is safe.
fn format_code_display(code: &str) -> String {
    format!("{} {}", &code[..3], &code[3..])
}

fn plain_text_body(code: &str) -> String {
    let code = format_code_display(code);
    format!(
        "Here's your StrewthGif sign-in code:\n\n    {code}\n\n\
         This code expires in 10 minutes.\n\n\
         If you didn't request this, you can ignore this email. Nobody can sign in without the code.\n\n\
         — StrewthGif"
    )
}

fn html_body(code: &str) -> String {
    let code = format_code_display(code);
    format!(
        "<div style=\"font-family:Helvetica,Arial,sans-serif;background:#f4f1e8;padding:32px\">\
         <div style=\"max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4dfcf\">\
         <div style=\"background:#111114;padding:20px 32px\">\
         <img src=\"https://media.strewthgif.com/brand/strewthgif-lockup-on-dark.png\" alt=\"StrewthGif\" \
         width=\"141\" height=\"28\" style=\"display:block;height:28px;width:141px;border:0\">\
         </div>\
         <div style=\"padding:32px\">\
         <p style=\"font-size:22px;font-weight:700;color:#111114;margin:0 0 18px\">Here's your sign-in code</p>\
         <p style=\"font-size:16px;color:#3a3b44;margin:0 0 18px\">Enter this code on StrewthGif to sign in:</p>\
         <div style=\"font-family:Menlo,Consolas,monospace;font-size:32px;letter-spacing:6px;text-align:center;\
         background:#fdf6d8;border:2px solid #f5c518;border-radius:8px;padding:16px 0;margin:0 0 18px\">{code}</div>\
         <p style=\"font-size:15px;color:#3a3b44;margin:0 0 8px\">This code expires in <b>10 minutes</b>.</p>\
         <p style=\"font-size:13px;color:#6c6d7a;margin:0\">If you didn't request this, you can ignore this email. \
         Nobody can sign in without the code.</p>\
         </div>\
         <div style=\"padding:18px 32px;border-top:1px solid #eee8d6\">\
         <p style=\"font-size:12px;color:#8a8b98;margin:0\">Sent by StrewthGif because this address was entered on \
         the sign-in page.</p>\
         </div>\
         </div></div>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_code_display_splits_into_two_groups_of_three() {
        assert_eq!(format_code_display("070372"), "070 372");
    }

    #[test]
    fn html_body_includes_header_grouped_code_and_footer() {
        let html = html_body("070372");
        assert!(html.contains("strewthgif-lockup-on-dark.png"), "missing header logo");
        assert!(html.contains("070 372"), "code not grouped into two blocks of 3");
        assert!(!html.contains("070372"), "ungrouped code leaked in alongside the grouped one");
        assert!(html.contains("Sent by StrewthGif because this address was entered"), "missing footer");
    }
}
