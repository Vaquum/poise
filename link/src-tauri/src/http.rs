//! The HTTP client Poise Link uses and the rules for the addresses it talks to.

use std::time::Duration;

use reqwest::{Client, Response, Url, header, redirect};
use url::Host;

/// Upper bound for ordinary requests; the event stream has its own idle timeout.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The most Poise Link reads from one response body.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

pub fn client() -> reqwest::Result<Client> {
    Client::builder()
        .user_agent(concat!("PoiseLink/", env!("CARGO_PKG_VERSION")))
        // A redirect could carry the device token to another address, so none is followed.
        .redirect(redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
}

/// Accepts https addresses, and plain http only to this computer (for
/// running Poise locally), with a host and without embedded credentials.
pub fn check_address(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(url) => {}
        "http" => return Err(format!("{url} is not encrypted; use its https:// address")),
        other => return Err(format!("{url} is not a web address ({other}:)")),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("{url} has no host name"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("an address with a user name or password in it is not accepted".to_owned());
    }
    Ok(())
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// `base` with `path` appended below any path the base already has.
pub fn join(base: &Url, path: &str) -> Url {
    let mut base = base.clone();
    base.set_query(None);
    base.set_fragment(None);
    if !base.path().ends_with('/') {
        let with_slash = format!("{}/", base.path());
        base.set_path(&with_slash);
    }
    base.join(path.trim_start_matches('/'))
        .expect("a relative path always joins onto an http(s) base")
}

#[derive(Debug, thiserror::Error)]
pub enum BodyError {
    #[error("{0}")]
    Read(#[from] reqwest::Error),
    #[error("the response is larger than {MAX_BODY_BYTES} bytes")]
    TooLarge,
}

/// Reads a whole response body, refusing anything over [`MAX_BODY_BYTES`].
pub async fn read_body(mut response: Response) -> Result<Vec<u8>, BodyError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(BodyError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A short description of an unexpected response, for error messages.
pub async fn describe(response: Response) -> String {
    let status = response.status();
    if status.is_redirection() {
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("nowhere")
            .to_owned();
        return format!("HTTP {status}, a redirect to {location} (not followed)");
    }
    match read_body(response).await {
        Ok(body) => {
            let text = String::from_utf8_lossy(&body);
            let text = text.trim();
            if text.is_empty() {
                format!("HTTP {status}")
            } else {
                let excerpt: String = text.chars().take(200).collect();
                format!("HTTP {status}: {excerpt}")
            }
        }
        Err(error) => format!("HTTP {status} (body unreadable: {error})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn https_addresses_are_accepted() {
        assert_eq!(check_address(&url("https://poise.example.com/")), Ok(()));
    }

    #[test]
    fn plain_http_is_only_accepted_on_this_computer() {
        for local in [
            "http://localhost:5555/",
            "http://127.0.0.1:8080/",
            "http://[::1]:9/",
        ] {
            assert_eq!(check_address(&url(local)), Ok(()), "{local}");
        }
        assert!(check_address(&url("http://poise.example.com/")).is_err());
        assert!(check_address(&url("http://localhost.example.com/")).is_err());
        assert!(check_address(&url("http://10.0.0.5/")).is_err());
    }

    #[test]
    fn other_schemes_and_embedded_credentials_are_refused() {
        assert!(check_address(&url("ftp://poise.example.com/")).is_err());
        assert!(check_address(&url("file:///etc/passwd")).is_err());
        assert!(check_address(&url("https://me:secret@poise.example.com/")).is_err());
        assert!(check_address(&url("https://me@poise.example.com/")).is_err());
    }

    #[test]
    fn join_keeps_the_base_path_and_drops_query_and_fragment() {
        assert_eq!(
            join(&url("https://h.example.com"), "api/link/events").as_str(),
            "https://h.example.com/api/link/events"
        );
        assert_eq!(
            join(
                &url("https://h.example.com/poise?x=1#y"),
                "/link/device/code"
            )
            .as_str(),
            "https://h.example.com/poise/link/device/code"
        );
    }
}
