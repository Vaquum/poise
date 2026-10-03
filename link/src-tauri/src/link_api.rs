//! The workspace's Link API, called with the device token
//! (`Authorization: Bearer`), as described in docs/Service-architecture.md.

use std::fmt;

use reqwest::{Client, Response, StatusCode, Url, header};
use serde::Deserialize;

use crate::http::{self, REQUEST_TIMEOUT};

pub const SNIPPETS_PATH: &str = "api/link/snippets";
pub const EVENTS_PATH: &str = "api/link/events";

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// The device was revoked (or the token never existed).
    #[error("the device token was not accepted (HTTP 401)")]
    Unauthorized,
    #[error("{url} answered {detail}")]
    Status { url: Url, detail: String },
    #[error("could not reach {url}: {source}")]
    Network {
        url: Url,
        #[source]
        source: reqwest::Error,
    },
    #[error("{url}: {problem}")]
    Protocol { url: Url, problem: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnippetsResponse {
    /// The `If-None-Match` version is still current.
    NotModified,
    Fresh {
        version: String,
        yaml: String,
        etag: Option<String>,
    },
}

#[derive(Deserialize)]
struct SnippetsBody {
    version: String,
    yaml: String,
}

#[derive(Clone)]
pub struct LinkApi {
    http: Client,
    endpoint: Url,
    token: String,
}

// Written by hand so the device token never reaches a log line.
impl fmt::Debug for LinkApi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinkApi")
            .field("endpoint", &self.endpoint.as_str())
            .finish_non_exhaustive()
    }
}

impl LinkApi {
    pub fn new(http: Client, endpoint: Url, token: String) -> Self {
        Self {
            http,
            endpoint,
            token,
        }
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    /// `GET /api/link/snippets`, conditional on `if_none_match` when given.
    pub async fn snippets(
        &self,
        if_none_match: Option<&str>,
    ) -> Result<SnippetsResponse, ApiError> {
        let url = http::join(&self.endpoint, SNIPPETS_PATH);
        let mut request = self
            .http
            .get(url.clone())
            .bearer_auth(&self.token)
            .timeout(REQUEST_TIMEOUT);
        if let Some(etag) = if_none_match {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let response = request.send().await.map_err(|source| ApiError::Network {
            url: url.clone(),
            source,
        })?;
        match response.status() {
            StatusCode::NOT_MODIFIED => Ok(SnippetsResponse::NotModified),
            status if status.is_success() => {
                let etag = response
                    .headers()
                    .get(header::ETAG)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let body = http::read_body(response)
                    .await
                    .map_err(|error| ApiError::Protocol {
                        url: url.clone(),
                        problem: error.to_string(),
                    })?;
                let body: SnippetsBody =
                    serde_json::from_slice(&body).map_err(|error| ApiError::Protocol {
                        url: url.clone(),
                        problem: format!("not a snippets response: {error}"),
                    })?;
                Ok(SnippetsResponse::Fresh {
                    version: body.version,
                    yaml: body.yaml,
                    etag,
                })
            }
            _ => Err(unexpected(response, url).await),
        }
    }

    /// Opens `GET /api/link/events`, resuming after `last_event_id`.
    pub async fn open_events(&self, last_event_id: Option<&str>) -> Result<Response, ApiError> {
        let url = http::join(&self.endpoint, EVENTS_PATH);
        let mut request = self
            .http
            .get(url.clone())
            .bearer_auth(&self.token)
            .header(header::ACCEPT, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache");
        if let Some(id) = last_event_id.filter(|id| !id.is_empty()) {
            match header::HeaderValue::from_str(id) {
                Ok(value) => request = request.header("Last-Event-ID", value),
                // Sent anyway it would fail every reconnect; without it the stream starts afresh.
                Err(_) => {
                    log::warn!("not resuming after event id {id:?}: it is not a valid header value")
                }
            }
        }
        let response = request.send().await.map_err(|source| ApiError::Network {
            url: url.clone(),
            source,
        })?;
        if !response.status().is_success() {
            return Err(unexpected(response, url).await);
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !content_type.starts_with("text/event-stream") {
            return Err(ApiError::Protocol {
                problem: format!("expected an event stream, got {content_type:?}"),
                url,
            });
        }
        Ok(response)
    }
}

async fn unexpected(response: Response, url: Url) -> ApiError {
    if response.status() == StatusCode::UNAUTHORIZED {
        return ApiError::Unauthorized;
    }
    ApiError::Status {
        detail: http::describe(response).await,
        url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_the_token() {
        let api = LinkApi::new(
            http::client().unwrap(),
            Url::parse("https://octocat.poise.example.com/").unwrap(),
            "secret-device-token".into(),
        );
        let printed = format!("{api:?}");
        assert!(printed.contains("octocat.poise.example.com"));
        assert!(!printed.contains("secret-device-token"));
    }
}
