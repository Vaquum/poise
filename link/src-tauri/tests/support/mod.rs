//! A fake Poise for the integration tests: the gateway's device pairing
//! endpoints and a workspace's Link API (snippets with an ETag, and the event
//! stream), on a local port, with switches to make it misbehave.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

pub const TOKEN: &str = "device-token-123";
pub const DEVICE_CODE: &str = "device-code-abc";
pub const USER_CODE: &str = "WDJB-MJHT";
pub const LOGIN: &str = "Octocat";

#[derive(Default)]
pub struct Config {
    /// Token polls answered `authorization_pending` before the token is issued.
    pub approve_after: usize,
    /// The token poll (1-based) answered `slow_down`.
    pub slow_down_at: Option<usize>,
    pub deny: bool,
    pub expire: bool,
    /// Answer the event stream with a redirect to `/stolen`.
    pub redirect_events: bool,
}

enum Frame {
    Text(String),
    Close,
}

pub struct State {
    pub config: Config,
    pub token_polls: usize,
    pub snippets_version: String,
    pub snippets_yaml: String,
    /// The `If-None-Match` header of each snippets request.
    pub if_none_match: Vec<Option<String>>,
    /// The `Last-Event-ID` header of each event stream connection.
    pub stream_connections: Vec<Option<String>>,
    /// The `Authorization` header of every Link API request.
    pub authorizations: Vec<Option<String>>,
    /// Frames sent after the snippets event on every new stream connection.
    pub replay: Vec<String>,
    pub revoked: bool,
    pub paths: Vec<String>,
    live: Option<mpsc::UnboundedSender<Frame>>,
}

pub struct FakePoise {
    pub url: Url,
    state: Arc<Mutex<State>>,
}

impl FakePoise {
    pub async fn start(config: Config, version: &str, yaml: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let state = Arc::new(Mutex::new(State {
            config,
            token_polls: 0,
            snippets_version: version.to_owned(),
            snippets_yaml: yaml.to_owned(),
            if_none_match: Vec::new(),
            stream_connections: Vec::new(),
            authorizations: Vec::new(),
            replay: Vec::new(),
            revoked: false,
            paths: Vec::new(),
            live: None,
        }));
        let shared = Arc::clone(&state);
        let base = url.clone();
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                tokio::spawn(serve(socket, Arc::clone(&shared), base.clone()));
            }
        });
        Self { url, state }
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    /// Sends raw event-stream text on the open stream.
    pub fn push(&self, text: &str) {
        let state = self.state();
        let live = state.live.as_ref().expect("no event stream is open");
        live.send(Frame::Text(text.to_owned()))
            .expect("the event stream went away");
    }

    /// Ends the open stream, as a network drop would.
    pub fn drop_stream(&self) {
        if let Some(live) = self.state().live.take() {
            let _ = live.send(Frame::Close);
        }
    }

    pub fn set_snippets(&self, version: &str, yaml: &str) {
        let mut state = self.state();
        state.snippets_version = version.to_owned();
        state.snippets_yaml = yaml.to_owned();
    }

    /// Revokes the device: every Link API request answers 401 from now on.
    pub fn revoke(&self) {
        self.state().revoked = true;
        self.drop_stream();
    }
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_request(socket: &mut TcpStream) -> Option<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some(Request {
        method,
        path,
        headers,
        body,
    })
}

fn response(status: &str, headers: &[(&str, &str)], body: &str) -> String {
    let mut out = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(body);
    out
}

fn json(status: &str, body: serde_json::Value) -> String {
    response(
        status,
        &[("Content-Type", "application/json")],
        &body.to_string(),
    )
}

enum Action {
    Reply(String),
    Stream {
        opening: String,
        frames: mpsc::UnboundedReceiver<Frame>,
    },
}

async fn serve(mut socket: TcpStream, state: Arc<Mutex<State>>, base: Url) {
    let Some(request) = read_request(&mut socket).await else {
        return;
    };
    // Decided under the lock, carried out after it is released.
    let action = route(&mut state.lock().unwrap(), &request, &base);
    match action {
        Action::Reply(reply) => {
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
        Action::Stream { opening, frames } => stream(socket, opening, frames).await,
    }
}

fn route(state: &mut State, request: &Request, base: &Url) -> Action {
    state.paths.push(request.path.clone());
    let reply = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/link/device/code") => json(
            "200 OK",
            serde_json::json!({
                "device_code": DEVICE_CODE,
                "user_code": USER_CODE,
                "verification_uri": "/link",
                "expires_in": 600,
                "interval": 1,
            }),
        ),
        ("POST", "/link/device/token") => token(state, request, base),
        ("GET", path) if path.starts_with("/api/link/") => {
            let authorization = request.headers.get("authorization").cloned();
            state.authorizations.push(authorization.clone());
            if state.revoked || authorization.as_deref() != Some(&format!("Bearer {TOKEN}")) {
                json(
                    "401 Unauthorized",
                    serde_json::json!({ "error": "unauthorized" }),
                )
            } else if path == "/api/link/snippets" {
                snippets(state, request)
            } else if path == "/api/link/events" && state.config.redirect_events {
                response("302 Found", &[("Location", &format!("{base}stolen"))], "")
            } else if path == "/api/link/events" {
                state
                    .stream_connections
                    .push(request.headers.get("last-event-id").cloned());
                let (live, frames) = mpsc::unbounded_channel();
                state.live = Some(live);
                let mut opening = format!(
                    "event: snippets\ndata: {{\"version\":\"{}\"}}\n\n",
                    state.snippets_version
                );
                for frame in &state.replay {
                    opening.push_str(frame);
                }
                return Action::Stream { opening, frames };
            } else {
                response("404 Not Found", &[], "")
            }
        }
        _ => response("404 Not Found", &[], ""),
    };
    Action::Reply(reply)
}

fn token(state: &mut State, request: &Request, base: &Url) -> String {
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap_or_default();
    if body["device_code"] != DEVICE_CODE {
        return json(
            "400 Bad Request",
            serde_json::json!({ "error": "invalid_grant" }),
        );
    }
    state.token_polls += 1;
    let poll = state.token_polls;
    let error = if state.config.deny {
        Some("access_denied")
    } else if state.config.expire {
        Some("expired_token")
    } else if state.config.slow_down_at == Some(poll) {
        Some("slow_down")
    } else if poll <= state.config.approve_after {
        Some("authorization_pending")
    } else {
        None
    };
    match error {
        Some(error) => json("400 Bad Request", serde_json::json!({ "error": error })),
        None => json(
            "200 OK",
            serde_json::json!({ "access_token": TOKEN, "endpoint": base.as_str(), "login": LOGIN }),
        ),
    }
}

fn snippets(state: &mut State, request: &Request) -> String {
    let if_none_match = request.headers.get("if-none-match").cloned();
    state.if_none_match.push(if_none_match.clone());
    let etag = format!("\"{}\"", state.snippets_version);
    if if_none_match.as_deref() == Some(etag.as_str()) {
        return response("304 Not Modified", &[("ETag", &etag)], "");
    }
    let body =
        serde_json::json!({ "version": state.snippets_version, "yaml": state.snippets_yaml })
            .to_string();
    response(
        "200 OK",
        &[("Content-Type", "application/json"), ("ETag", &etag)],
        &body,
    )
}

async fn stream(
    mut socket: TcpStream,
    opening: String,
    mut frames: mpsc::UnboundedReceiver<Frame>,
) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if socket.write_all(head.as_bytes()).await.is_err()
        || socket.write_all(opening.as_bytes()).await.is_err()
    {
        return;
    }
    while let Some(frame) = frames.recv().await {
        match frame {
            Frame::Text(text) => {
                if socket.write_all(text.as_bytes()).await.is_err() {
                    return;
                }
            }
            Frame::Close => break,
        }
    }
    let _ = socket.shutdown().await;
}

/// Waits until `condition` holds, failing the test after `timeout`.
pub async fn eventually(what: &str, timeout: Duration, mut condition: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + timeout;
    while !condition() {
        if tokio::time::Instant::now() >= deadline {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
