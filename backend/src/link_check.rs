//! SPEC.md §13: a lightweight server-side sanity check for a submitted GIF
//! URL — confirms it resolves and looks like an image, with basic SSRF
//! guards, before creating a linked `gifs` row. No file body is ever
//! downloaded or stored; this only inspects response headers.

use std::net::{IpAddr, Ipv6Addr};

use anyhow::{Context, Result, bail};
use reqwest::{Client, Response, Url};

/// Builds the shared client used for the SPEC.md §13 URL sanity check.
/// Redirects aren't followed (see `guard_against_private_hosts`'s doc
/// comment) and a short timeout keeps a slow/unresponsive third-party
/// host from hanging the request. An explicit User-Agent matters too:
/// several CDNs (Wikimedia confirmed directly, likely also Giphy/Discord/
/// imgur) 403 a request with reqwest's default blank one.
pub fn build_client() -> reqwest::Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!("gifiac/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// Validates that `raw_url` is safe and plausible to link to. Returns
/// `Err` with a human-readable reason (surfaced to the client as a 400) on
/// any failure — unresolvable host, disallowed (private/internal) address,
/// non-2xx response, or a content-type that doesn't look like an image.
pub async fn check_linkable(client: &Client, raw_url: &str) -> Result<()> {
    let url = Url::parse(raw_url).context("not a valid URL")?;
    match url.scheme() {
        "http" | "https" => {}
        other => bail!("unsupported URL scheme \"{other}\" — only http/https are allowed"),
    }
    let host = url.host_str().context("URL has no host")?;
    guard_against_private_hosts(host).await?;

    // Some CDNs don't support HEAD well (405/501) — fall back to a GET in
    // that case, but only ever read headers, never the body.
    let head = client.head(url.clone()).send().await.context("request failed")?;
    let response = if head.status().is_success() {
        head
    } else {
        client.get(url).send().await.context("request failed")?
    };

    if !response.status().is_success() {
        bail!("URL responded with {}", response.status());
    }
    if !has_image_content_type(&response) {
        bail!("URL does not look like an image (missing or non-image content-type)");
    }
    Ok(())
}

fn has_image_content_type(response: &Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("image/"))
}

/// Resolves `host` and rejects it if any resolved address is private,
/// loopback, link-local, or otherwise non-public — a guard against the
/// server being made to probe internal network addresses via a submitted
/// URL. Not hardened against DNS-rebinding (the actual outbound request
/// re-resolves independently, and redirects aren't followed — see
/// `client` construction in state.rs), but this is meant as a lightweight
/// sanity check per SPEC.md §13, not a hardened egress proxy.
async fn guard_against_private_hosts(host: &str) -> Result<()> {
    let addrs = tokio::net::lookup_host((host, 443))
        .await
        .with_context(|| format!("failed to resolve {host}"))?;
    let mut resolved_any = false;
    for addr in addrs {
        resolved_any = true;
        if is_disallowed(addr.ip()) {
            bail!("{host} resolves to a disallowed (private/internal) address");
        }
    }
    if !resolved_any {
        bail!("{host} did not resolve to any address");
    }
    Ok(())
}

fn is_disallowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || is_unique_local(v6) || is_unicast_link_local(v6)
        }
    }
}

/// fc00::/7 — `Ipv6Addr::is_unique_local` isn't stable yet.
fn is_unique_local(v6: Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xfe00) == 0xfc00
}

/// fe80::/10 — `Ipv6Addr::is_unicast_link_local` isn't stable yet.
fn is_unicast_link_local(v6: Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disallows_common_private_and_loopback_v4_ranges() {
        for ip in ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0"] {
            assert!(is_disallowed(ip.parse().unwrap()), "{ip} should be disallowed");
        }
    }

    #[test]
    fn allows_ordinary_public_v4_addresses() {
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34"] {
            assert!(!is_disallowed(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn disallows_v6_loopback_link_local_and_unique_local() {
        for ip in ["::1", "fe80::1", "fc00::1", "fd12:3456:789a::1"] {
            assert!(is_disallowed(ip.parse().unwrap()), "{ip} should be disallowed");
        }
    }

    #[test]
    fn allows_ordinary_public_v6_addresses() {
        assert!(!is_disallowed("2606:4700:4700::1111".parse().unwrap()));
    }

    #[tokio::test]
    async fn rejects_a_non_http_scheme() {
        let client = Client::new();
        let err = check_linkable(&client, "ftp://example.com/a.gif").await.unwrap_err();
        assert!(err.to_string().contains("scheme"), "{err}");
    }

    #[tokio::test]
    async fn rejects_an_unparseable_url() {
        let client = Client::new();
        assert!(check_linkable(&client, "not a url").await.is_err());
    }

    #[tokio::test]
    async fn rejects_a_url_that_resolves_to_a_loopback_address() {
        let client = Client::new();
        let err = check_linkable(&client, "http://127.0.0.1/a.gif").await.unwrap_err();
        assert!(err.to_string().contains("disallowed"), "{err}");
    }
}
