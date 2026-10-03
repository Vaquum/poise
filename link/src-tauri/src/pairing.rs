//! Device pairing with the Poise gateway: the device-code flow of RFC 8628 as
//! docs/Service-architecture.md describes it.
//!
//! 1. `POST /link/device/code` returns a device code, the code the person
//!    confirms, the page to confirm it on, and how often to poll.
//! 2. The person confirms the code at `verification_uri` in their browser.
//! 3. `POST /link/device/token` answers `authorization_pending` until then,
//!    and finally the device token, the workspace address and the login.

use std::future::Future;
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::json;

use crate::http::{self, REQUEST_TIMEOUT};

pub const CODE_PATH: &str = "link/device/code";
pub const TOKEN_PATH: &str = "link/device/token";
/// RFC 8628: poll every five seconds unless the server says otherwise.
const DEFAULT_INTERVAL_SECS: u64 = 5;
/// RFC 8628: after `slow_down`, poll five seconds less often.
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);
/// Upper bounds for what the gateway may ask for. Anything longer is already
/// unreasonable, and far larger values would overflow the timers.
const MAX_LIFETIME: Duration = Duration::from_secs(60 * 60);
const MAX_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("{0}")]
    InvalidAddress(String),
    #[error("could not reach {url}: {source}")]
    Unreachable {
        url: Url,
        #[source]
        source: reqwest::Error,
    },
    #[error(
        "{url} answered {detail}. Enter the Poise address you sign in at, for example https://poise.example.com"
    )]
    Rejected { url: Url, detail: String },
    #[error("the pairing request was declined in Poise")]
    Denied,
    #[error("the pairing code expired before it was confirmed; start again")]
    Expired,
    #[error("the server's answer was not understood: {0}")]
    Protocol(String),
    #[error("could not keep the device token: {0}")]
    Storage(String),
}

/// What `POST /link/device/code` returns, with the confirmation page resolved
/// against the server address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: Url,
    pub expires_in: Duration,
    pub interval: Duration,
}

/// A completed pairing.
#[derive(Clone, PartialEq, Eq)]
pub struct Pairing {
    pub access_token: String,
    pub endpoint: Url,
    pub login: String,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing")
            .field("endpoint", &self.endpoint.as_str())
            .field("login", &self.login)
            .finish_non_exhaustive()
    }
}

/// Turns what the person typed into the server address: `https://` is
/// assumed when no scheme is given.
pub fn parse_server_address(input: &str) -> Result<Url, PairingError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(PairingError::InvalidAddress(
            "enter your Poise address".to_owned(),
        ));
    }
    let with_scheme = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|error| {
        PairingError::InvalidAddress(format!("{input} is not an address: {error}"))
    })?;
    http::check_address(&url).map_err(PairingError::InvalidAddress)?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[derive(Deserialize)]
struct CodeBody {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: Option<u64>,
}

/// `POST /link/device/code`.
pub async fn request_code(client: &Client, server: &Url) -> Result<DeviceCode, PairingError> {
    let url = http::join(server, CODE_PATH);
    let response = client
        .post(url.clone())
        .json(&json!({}))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|source| PairingError::Unreachable {
            url: url.clone(),
            source,
        })?;
    if !response.status().is_success() {
        return Err(PairingError::Rejected {
            detail: http::describe(response).await,
            url,
        });
    }
    let body = http::read_body(response)
        .await
        .map_err(|error| PairingError::Protocol(error.to_string()))?;
    let code: CodeBody = serde_json::from_slice(&body)
        .map_err(|error| PairingError::Protocol(format!("device code response: {error}")))?;
    let verification_uri = server
        .join(&code.verification_uri)
        .map_err(|error| PairingError::Protocol(format!("verification_uri: {error}")))?;
    http::check_address(&verification_uri)
        .map_err(|error| PairingError::Protocol(format!("verification_uri: {error}")))?;
    if code.device_code.is_empty() || code.user_code.is_empty() || code.expires_in == 0 {
        return Err(PairingError::Protocol(
            "device code response is missing the code or its lifetime".to_owned(),
        ));
    }
    Ok(DeviceCode {
        device_code: code.device_code,
        user_code: code.user_code,
        verification_uri,
        expires_in: Duration::from_secs(code.expires_in).min(MAX_LIFETIME),
        interval: poll_interval(code.interval),
    })
}

/// The polling interval the gateway asked for, within bounds. Zero would
/// poll in a busy loop.
fn poll_interval(seconds: Option<u64>) -> Duration {
    Duration::from_secs(
        seconds
            .unwrap_or(DEFAULT_INTERVAL_SECS)
            .clamp(1, MAX_INTERVAL.as_secs()),
    )
}

fn slowed_down(interval: Duration) -> Duration {
    (interval + SLOW_DOWN_STEP).min(MAX_INTERVAL)
}

/// One answer from the token endpoint.
#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    Pending,
    SlowDown,
    Paired(Pairing),
    /// Worth asking again (a 5xx or an unreadable answer from a proxy).
    Transient(String),
}

#[derive(Deserialize)]
struct TokenBody {
    access_token: Option<String>,
    endpoint: Option<String>,
    login: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Interprets a token endpoint answer. Errors arrive as `{ "error": … }`,
/// whatever the HTTP status.
pub fn classify(status: StatusCode, body: &[u8]) -> Result<Poll, PairingError> {
    let parsed: TokenBody = match serde_json::from_slice(body) {
        Ok(parsed) => parsed,
        Err(_) if status.is_server_error() => return Ok(Poll::Transient(format!("HTTP {status}"))),
        Err(error) => {
            return Err(PairingError::Protocol(format!(
                "token response (HTTP {status}): {error}"
            )));
        }
    };
    if let Some(error) = parsed.error.as_deref() {
        return match error {
            "authorization_pending" => Ok(Poll::Pending),
            "slow_down" => Ok(Poll::SlowDown),
            "expired_token" => Err(PairingError::Expired),
            "access_denied" => Err(PairingError::Denied),
            other => Err(PairingError::Protocol(match parsed.error_description {
                Some(description) => format!("{other}: {description}"),
                None => other.to_owned(),
            })),
        };
    }
    if status.is_server_error() {
        return Ok(Poll::Transient(format!("HTTP {status}")));
    }
    match (parsed.access_token, parsed.endpoint, parsed.login) {
        (Some(access_token), Some(endpoint), Some(login))
            if status.is_success() && !access_token.is_empty() && !login.is_empty() =>
        {
            let endpoint = Url::parse(&endpoint).map_err(|error| {
                PairingError::Protocol(format!("endpoint {endpoint:?}: {error}"))
            })?;
            http::check_address(&endpoint)
                .map_err(|error| PairingError::Protocol(format!("endpoint: {error}")))?;
            Ok(Poll::Paired(Pairing {
                access_token,
                endpoint,
                login,
            }))
        }
        _ => Err(PairingError::Protocol(format!(
            "token response (HTTP {status}) has neither a token, an endpoint and a login, nor an error"
        ))),
    }
}

/// Polls `POST /link/device/token` until the person confirms the code, it is
/// declined, or it expires. `sleep` waits between polls (tests pass a
/// recorder instead of a real timer).
pub async fn wait_for_token<S, F>(
    client: &Client,
    server: &Url,
    code: &DeviceCode,
    sleep: S,
) -> Result<Pairing, PairingError>
where
    S: Fn(Duration) -> F,
    F: Future<Output = ()>,
{
    let url = http::join(server, TOKEN_PATH);
    let deadline = Instant::now() + code.expires_in;
    let mut interval = code.interval;
    loop {
        sleep(interval).await;
        if Instant::now() >= deadline {
            return Err(PairingError::Expired);
        }
        let response = client
            .post(url.clone())
            .json(&json!({ "device_code": code.device_code }))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await;
        let poll = match response {
            Ok(response) => {
                let status = response.status();
                match http::read_body(response).await {
                    Ok(body) => classify(status, &body)?,
                    Err(error) => Poll::Transient(error.to_string()),
                }
            }
            Err(error) => Poll::Transient(error.to_string()),
        };
        match poll {
            Poll::Pending => {}
            Poll::SlowDown => interval = slowed_down(interval),
            Poll::Paired(pairing) => return Ok(pairing),
            Poll::Transient(problem) => {
                log::warn!("waiting for pairing: {url} failed ({problem}); trying again");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_address_gets_https_when_no_scheme_is_given() {
        assert_eq!(
            parse_server_address("  poise.example.com ")
                .unwrap()
                .as_str(),
            "https://poise.example.com/"
        );
        assert_eq!(
            parse_server_address("https://poise.example.com/?a=1#b")
                .unwrap()
                .as_str(),
            "https://poise.example.com/"
        );
        assert_eq!(
            parse_server_address("http://127.0.0.1:5555")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:5555/"
        );
    }

    #[test]
    fn unsafe_or_meaningless_addresses_are_refused() {
        for input in [
            "",
            "   ",
            "http://poise.example.com",
            "ftp://poise.example.com",
            "https://user:pw@poise.example.com",
            "https://",
            "not a host name",
        ] {
            assert!(
                matches!(
                    parse_server_address(input),
                    Err(PairingError::InvalidAddress(_))
                ),
                "{input:?} was accepted"
            );
        }
    }

    fn paired(body: &str) -> Pairing {
        match classify(StatusCode::OK, body.as_bytes()).unwrap() {
            Poll::Paired(pairing) => pairing,
            other => panic!("expected a pairing, got {other:?}"),
        }
    }

    #[test]
    fn classifies_pending_slow_down_and_success() {
        let bad = StatusCode::BAD_REQUEST;
        assert_eq!(
            classify(bad, br#"{"error":"authorization_pending"}"#).unwrap(),
            Poll::Pending
        );
        assert_eq!(
            classify(StatusCode::OK, br#"{"error":"authorization_pending"}"#).unwrap(),
            Poll::Pending
        );
        assert_eq!(
            classify(bad, br#"{"error":"slow_down"}"#).unwrap(),
            Poll::SlowDown
        );
        let pairing = paired(
            r#"{"access_token":"t","endpoint":"https://octocat.poise.example.com","login":"Octocat"}"#,
        );
        assert_eq!(
            pairing.endpoint.as_str(),
            "https://octocat.poise.example.com/"
        );
        assert_eq!(pairing.login, "Octocat");
    }

    #[test]
    fn expired_and_denied_codes_end_pairing() {
        let bad = StatusCode::BAD_REQUEST;
        assert!(matches!(
            classify(bad, br#"{"error":"expired_token"}"#),
            Err(PairingError::Expired)
        ));
        assert!(matches!(
            classify(bad, br#"{"error":"access_denied"}"#),
            Err(PairingError::Denied)
        ));
        assert!(matches!(
            classify(bad, br#"{"error":"invalid_grant","error_description":"unknown device code"}"#),
            Err(PairingError::Protocol(message)) if message == "invalid_grant: unknown device code"
        ));
    }

    #[test]
    fn incomplete_or_unsafe_token_responses_are_refused() {
        let ok = StatusCode::OK;
        for body in [
            r#"{"access_token":"t","login":"o"}"#,
            r#"{"access_token":"","endpoint":"https://a.example.com","login":"o"}"#,
            r#"{"access_token":"t","endpoint":"https://a.example.com","login":""}"#,
            r#"{"access_token":"t","endpoint":"http://a.example.com","login":"o"}"#,
            r#"{"access_token":"t","endpoint":"javascript:alert(1)","login":"o"}"#,
            r#"{}"#,
            "<html>sign in</html>",
        ] {
            assert!(
                classify(ok, body.as_bytes()).is_err(),
                "{body} was accepted"
            );
        }
        // A token in an error status is not a pairing.
        assert!(
            classify(
                StatusCode::FORBIDDEN,
                br#"{"access_token":"t","endpoint":"https://a.example.com","login":"o"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn server_errors_are_retried() {
        assert!(matches!(
            classify(StatusCode::BAD_GATEWAY, b"<html>bad gateway</html>").unwrap(),
            Poll::Transient(_)
        ));
        assert!(matches!(
            classify(StatusCode::SERVICE_UNAVAILABLE, b"{}").unwrap(),
            Poll::Transient(_)
        ));
    }

    #[test]
    fn polling_stays_within_bounds_whatever_the_gateway_asks() {
        assert_eq!(poll_interval(None), Duration::from_secs(5));
        assert_eq!(poll_interval(Some(0)), Duration::from_secs(1));
        assert_eq!(poll_interval(Some(7)), Duration::from_secs(7));
        assert_eq!(poll_interval(Some(u64::MAX)), MAX_INTERVAL);
        assert_eq!(slowed_down(Duration::from_secs(1)), Duration::from_secs(6));
        assert_eq!(slowed_down(MAX_INTERVAL), MAX_INTERVAL);
    }

    #[test]
    fn pairing_debug_output_hides_the_token() {
        let pairing = paired(
            r#"{"access_token":"secret-token","endpoint":"https://a.example.com","login":"o"}"#,
        );
        assert!(!format!("{pairing:?}").contains("secret-token"));
    }
}
