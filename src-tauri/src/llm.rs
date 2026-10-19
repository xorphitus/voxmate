//! Streaming client for OpenAI-compatible chat APIs (llama-swap, Ollama,
//! LM Studio, vLLM...).
//!
//! Only `POST /v1/chat/completions` with `stream: true`. Text deltas are
//! handed to a callback as they arrive; the frontend splits them into
//! sentences.

use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid LLM URL {0:?} (expected http:// or https://)")]
    InvalidUrl(String),
    #[error("cannot reach LLM at {url}: {source}")]
    Unreachable { url: String, source: reqwest::Error },
    #[error("LLM request failed with HTTP {status}: {body}")]
    Status { status: u16, body: String },
    #[error("LLM stream broke off: {0}")]
    Stream(#[from] reqwest::Error),
    #[error("LLM error: {0}")]
    Api(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

/// Splits a byte stream into server-sent event `data:` payloads. Bytes are
/// buffered until a full line arrives, so multi-byte UTF-8 split across
/// chunks stays intact.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(end) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data:") {
                out.push(data.trim_start().to_string());
            }
        }
        out
    }
}

/// What one `data:` payload means for the caller.
#[derive(Debug, PartialEq)]
pub enum Chunk {
    Delta(String),
    Done,
    Skip,
}

pub fn parse_chunk(data: &str) -> Result<Chunk> {
    if data == "[DONE]" {
        return Ok(Chunk::Done);
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Ok(Chunk::Skip);
    };
    if let Some(err) = value.get("error") {
        let msg = err.get("message").and_then(Value::as_str).map(str::to_owned);
        return Err(Error::Api(msg.unwrap_or_else(|| err.to_string())));
    }
    let delta = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(if delta.is_empty() {
        Chunk::Skip
    } else {
        Chunk::Delta(delta.to_string())
    })
}

fn parse_base_url(raw: &str) -> Result<Url> {
    let trimmed = raw.trim().trim_end_matches('/');
    match Url::parse(trimmed) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => Ok(url),
        _ => Err(Error::InvalidUrl(raw.to_string())),
    }
}

pub struct LlmClient {
    http: Client,
}

impl LlmClient {
    pub fn new() -> Result<Self> {
        // No overall timeout: a reply may stream for minutes, and a cold
        // llama-swap model swap can take a while before the first token.
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .map_err(Error::Stream)?;
        Ok(Self { http })
    }

    /// Streams a chat completion, calling `on_delta` for each piece of text.
    pub async fn chat(
        &self,
        base_url: &str,
        model: &str,
        messages: &[ChatMessage],
        mut on_delta: impl FnMut(String),
    ) -> Result<()> {
        let base = parse_base_url(base_url)?;
        let url = format!("{}/v1/chat/completions", base.as_str().trim_end_matches('/'));
        let body = ChatRequest {
            model,
            messages,
            stream: true,
        };
        let mut res = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|source| Error::Unreachable {
                url: base.to_string(),
                source,
            })?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(Error::Status {
                status: status.as_u16(),
                body,
            });
        }

        let mut parser = SseParser::default();
        while let Some(bytes) = res.chunk().await? {
            for data in parser.push(&bytes) {
                match parse_chunk(&data)? {
                    Chunk::Delta(text) => on_delta(text),
                    Chunk::Done => return Ok(()),
                    Chunk::Skip => {}
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn delta(text: &str) -> String {
        format!(
            "data: {}\n\n",
            json!({"choices": [{"index": 0, "delta": {"content": text}}]})
        )
    }

    #[test]
    fn sse_parser_reassembles_split_lines_and_utf8() {
        let mut p = SseParser::default();
        let line = delta("ずんだ");
        let bytes = line.as_bytes();
        // Split inside a multi-byte character.
        let (a, b) = bytes.split_at(bytes.len() - 8);
        assert!(p.push(a).is_empty());
        let out = p.push(b);
        assert_eq!(out.len(), 1);
        assert_eq!(parse_chunk(&out[0]).unwrap(), Chunk::Delta("ずんだ".into()));
    }

    #[test]
    fn sse_parser_ignores_comments_and_handles_crlf() {
        let mut p = SseParser::default();
        let out = p.push(b": keep-alive\r\ndata: [DONE]\r\n\r\n");
        assert_eq!(out, vec!["[DONE]".to_string()]);
    }

    #[test]
    fn parse_chunk_skips_role_only_and_reports_errors() {
        let role = json!({"choices": [{"delta": {"role": "assistant"}}]}).to_string();
        assert_eq!(parse_chunk(&role).unwrap(), Chunk::Skip);
        let err = json!({"error": {"message": "model not found"}}).to_string();
        assert!(matches!(parse_chunk(&err), Err(Error::Api(m)) if m == "model not found"));
    }

    #[tokio::test]
    async fn streams_deltas_until_done() {
        let server = MockServer::start().await;
        let body = [
            delta("こんにちは。"),
            delta("元気"),
            "data: [DONE]\n\n".into(),
            delta("ignored"),
        ]
        .concat();
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_partial_json(json!({"model": "qwen", "stream": true})))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream"))
            .mount(&server)
            .await;

        let client = LlmClient::new().unwrap();
        let messages = [ChatMessage {
            role: "user".into(),
            content: "hi".into(),
        }];
        let mut got = Vec::new();
        client
            .chat(&server.uri(), "qwen", &messages, |d| got.push(d))
            .await
            .unwrap();
        assert_eq!(got, vec!["こんにちは。", "元気"]);
    }

    #[tokio::test]
    async fn reports_http_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(404).set_body_string("no such model"))
            .mount(&server)
            .await;

        let client = LlmClient::new().unwrap();
        let err = client.chat(&server.uri(), "x", &[], |_| {}).await.unwrap_err();
        assert!(matches!(err, Error::Status { status: 404, ref body } if body == "no such model"));
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(matches!(parse_base_url("file:///etc"), Err(Error::InvalidUrl(_))));
    }
}
