//! Local HTTP API so other programs (scripts, a future LLM bridge, ...) can
//! make the avatar speak.
//!
//! The server binds to 127.0.0.1 only. On top of that it rejects requests
//! whose `Host` is not a loopback name (DNS rebinding) and only accepts
//! `application/json` bodies, which browsers cannot send cross-origin without
//! a CORS preflight that this server never approves.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const DEFAULT_PORT: u16 = 50080;
pub const MAX_TEXT_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpeakRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u32>,
}

/// Receives validated speak requests (in the app: emits a Tauri event).
pub type SpeakSink = Arc<dyn Fn(SpeakRequest) + Send + Sync>;

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

pub fn validate(req: SpeakRequest) -> Result<SpeakRequest, String> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err("text must not be empty".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("text is longer than {MAX_TEXT_CHARS} characters"));
    }
    Ok(SpeakRequest {
        text: text.to_string(),
        speaker: req.speaker,
    })
}

/// One stderr line per accepted request. Lets a client that re-sends text be
/// told apart from the app speaking something twice. The text itself is not
/// logged, only its length and hash.
fn log_request(client: Option<SocketAddr>, req: &SpeakRequest) {
    let mut hasher = DefaultHasher::new();
    req.text.hash(&mut hasher);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64());
    let client = client.map_or_else(|| "unknown".to_string(), |addr| addr.to_string());
    eprintln!(
        "[{now:.3}] POST /speak from {client}: {} chars, hash {:016x}, speaker {:?}",
        req.text.chars().count(),
        hasher.finish(),
        req.speaker,
    );
}

async fn speak(
    State(sink): State<SpeakSink>,
    client: Option<Extension<ConnectInfo<SocketAddr>>>,
    body: Result<Json<SpeakRequest>, JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return error(rejection.status(), rejection.body_text()),
    };
    match validate(req) {
        Ok(req) => {
            log_request(client.map(|Extension(ConnectInfo(addr))| addr), &req);
            sink(req);
            (StatusCode::ACCEPTED, Json(json!({ "status": "queued" }))).into_response()
        }
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "name": "voxmate", "version": env!("CARGO_PKG_VERSION") }))
}

fn is_loopback_host(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    };
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

async fn require_loopback_host(req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(is_loopback_host);
    if !ok {
        return error(StatusCode::FORBIDDEN, "only loopback Host headers are accepted");
    }
    next.run(req).await
}

pub fn router(sink: SpeakSink) -> Router {
    Router::new()
        .route("/speak", post(speak))
        .route("/health", get(health))
        .layer(middleware::from_fn(require_loopback_host))
        .with_state(sink)
}

/// Binds synchronously so a port conflict can be reported at startup.
pub fn bind(port: u16) -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Must be called from inside a tokio runtime.
pub async fn serve(listener: TcpListener, sink: SpeakSink) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let app = router(sink).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::sync::Mutex;
    use tower::ServiceExt;

    fn capture() -> (SpeakSink, Arc<Mutex<Vec<SpeakRequest>>>) {
        let got = Arc::new(Mutex::new(Vec::<SpeakRequest>::new()));
        let got2 = got.clone();
        let sink: SpeakSink = Arc::new(move |req: SpeakRequest| got2.lock().unwrap().push(req));
        (sink, got)
    }

    fn post_speak(body: &str, content_type: &str) -> Request<Body> {
        Request::post("/speak")
            .header(header::HOST, "127.0.0.1:50080")
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn body_json(res: Response) -> serde_json::Value {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn accepts_valid_request() {
        let (sink, got) = capture();
        let res = router(sink)
            .oneshot(post_speak(
                r#"{"text":"  こんにちは ","speaker":3}"#,
                "application/json",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(body_json(res).await, json!({"status": "queued"}));
        assert_eq!(
            *got.lock().unwrap(),
            vec![SpeakRequest {
                text: "こんにちは".into(),
                speaker: Some(3)
            }]
        );
    }

    #[tokio::test]
    async fn speaker_is_optional() {
        let (sink, got) = capture();
        let res = router(sink)
            .oneshot(post_speak(r#"{"text":"hi"}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(got.lock().unwrap()[0].speaker, None);
    }

    #[tokio::test]
    async fn rejects_blank_text() {
        let (sink, got) = capture();
        let res = router(sink)
            .oneshot(post_speak(r#"{"text":"   "}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(got.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_too_long_text() {
        let (sink, _) = capture();
        let long = "あ".repeat(MAX_TEXT_CHARS + 1);
        let res = router(sink)
            .oneshot(post_speak(
                &json!({ "text": long }).to_string(),
                "application/json",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn rejects_malformed_json() {
        let (sink, _) = capture();
        let res = router(sink.clone())
            .oneshot(post_speak(r#"{"speaker":1}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let res = router(sink)
            .oneshot(post_speak("{not json", "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn rejects_non_json_content_type() {
        let (sink, got) = capture();
        let res = router(sink)
            .oneshot(post_speak(r#"{"text":"hi"}"#, "text/plain"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(got.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_foreign_host() {
        let (sink, got) = capture();
        let req = Request::post("/speak")
            .header(header::HOST, "evil.example:50080")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"text":"hi"}"#))
            .unwrap();
        let res = router(sink).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(got.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn health_ok() {
        let (sink, _) = capture();
        let req = Request::get("/health")
            .header(header::HOST, "localhost:50080")
            .body(Body::empty())
            .unwrap();
        let res = router(sink).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["ok"], json!(true));
    }

    #[test]
    fn loopback_host_names() {
        assert!(is_loopback_host("127.0.0.1:50080"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("[::1]:1"));
        assert!(!is_loopback_host("localhost.evil.example"));
        assert!(!is_loopback_host("192.168.0.2:50080"));
    }

    #[tokio::test]
    async fn serves_on_loopback() {
        let listener = bind(0).unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        let (sink, got) = capture();
        tokio::spawn(serve(listener, sink));

        let res = reqwest::Client::new()
            .post(format!("http://{addr}/speak"))
            .json(&json!({"text": "テスト"}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 202);
        assert_eq!(got.lock().unwrap()[0].text, "テスト");
    }
}
