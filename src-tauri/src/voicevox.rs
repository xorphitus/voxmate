//! Minimal client for the VOICEVOX engine HTTP API.
//!
//! Only the endpoints voxmate needs: `GET /speakers`, `POST /audio_query` and
//! `POST /synthesis`. The audio query is kept as raw JSON so fields added by
//! newer engine versions survive the round trip to `/synthesis` untouched.

use std::sync::RwLock;
use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_URL: &str = "http://127.0.0.1:50021";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid VOICEVOX URL {0:?} (expected http:// or https://)")]
    InvalidUrl(String),
    #[error("cannot reach VOICEVOX engine at {url}: {source}")]
    Unreachable { url: String, source: reqwest::Error },
    #[error("VOICEVOX {endpoint} failed with HTTP {status}: {body}")]
    Status {
        endpoint: &'static str,
        status: u16,
        body: String,
    },
    #[error("unexpected VOICEVOX response: {0}")]
    Decode(#[from] reqwest::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpeakerStyle {
    pub name: String,
    pub id: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Speaker {
    pub name: String,
    pub speaker_uuid: String,
    pub styles: Vec<SpeakerStyle>,
}

#[derive(Debug, Clone)]
pub struct Synthesis {
    pub query: Value,
    pub wav: Vec<u8>,
}

impl Synthesis {
    /// Packs the result into one binary IPC payload:
    /// `[u32 LE json length][audio query JSON][wav bytes]`.
    /// Sending raw bytes avoids serializing the wav as a JSON number array.
    pub fn pack(&self) -> Vec<u8> {
        let json = serde_json::to_vec(&self.query).expect("Value always serializes");
        let mut out = Vec::with_capacity(4 + json.len() + self.wav.len());
        out.extend_from_slice(&(json.len() as u32).to_le_bytes());
        out.extend_from_slice(&json);
        out.extend_from_slice(&self.wav);
        out
    }
}

pub struct VoicevoxClient {
    http: Client,
    base_url: RwLock<Url>,
}

fn parse_base_url(raw: &str) -> Result<Url> {
    let trimmed = raw.trim().trim_end_matches('/');
    match Url::parse(trimmed) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => Ok(url),
        _ => Err(Error::InvalidUrl(raw.to_string())),
    }
}

impl VoicevoxClient {
    pub fn new(base_url: &str) -> Result<Self> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            // Long sentences can take a while on CPU-only engines.
            .timeout(Duration::from_secs(120))
            .build()?;
        Ok(Self {
            http,
            base_url: RwLock::new(parse_base_url(base_url)?),
        })
    }

    pub fn base_url(&self) -> String {
        self.base_url.read().unwrap().as_str().trim_end_matches('/').to_string()
    }

    pub fn set_base_url(&self, raw: &str) -> Result<()> {
        *self.base_url.write().unwrap() = parse_base_url(raw)?;
        Ok(())
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url(), path)
    }

    async fn send(
        &self,
        endpoint: &'static str,
        req: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response> {
        let res = req.send().await.map_err(|source| Error::Unreachable {
            url: self.base_url(),
            source,
        })?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(Error::Status {
                endpoint,
                status: status.as_u16(),
                body,
            });
        }
        Ok(res)
    }

    pub async fn speakers(&self) -> Result<Vec<Speaker>> {
        let req = self.http.get(self.endpoint("/speakers"));
        Ok(self.send("/speakers", req).await?.json().await?)
    }

    pub async fn audio_query(&self, text: &str, speaker: u32) -> Result<Value> {
        let speaker = speaker.to_string();
        let req = self
            .http
            .post(self.endpoint("/audio_query"))
            .query(&[("text", text), ("speaker", speaker.as_str())]);
        Ok(self.send("/audio_query", req).await?.json().await?)
    }

    pub async fn synthesis(&self, query: &Value, speaker: u32) -> Result<Vec<u8>> {
        let req = self
            .http
            .post(self.endpoint("/synthesis"))
            .query(&[("speaker", speaker)])
            .json(query);
        Ok(self.send("/synthesis", req).await?.bytes().await?.to_vec())
    }

    pub async fn synthesize(&self, text: &str, speaker: u32) -> Result<Synthesis> {
        let query = self.audio_query(text, speaker).await?;
        let wav = self.synthesis(&query, speaker).await?;
        Ok(Synthesis { query, wav })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_json, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_query() -> Value {
        json!({
            "accent_phrases": [],
            "speedScale": 1.0,
            "prePhonemeLength": 0.1,
            "postPhonemeLength": 0.1,
            "outputSamplingRate": 24000,
            "kana": "コンニチワ"
        })
    }

    #[tokio::test]
    async fn lists_speakers() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/speakers"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
                "name": "ずんだもん",
                "speaker_uuid": "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9",
                "styles": [{"name": "ノーマル", "id": 3, "type": "talk"}],
                "version": "0.15.0"
            }])))
            .mount(&server)
            .await;

        let client = VoicevoxClient::new(&server.uri()).unwrap();
        let speakers = client.speakers().await.unwrap();
        assert_eq!(speakers.len(), 1);
        assert_eq!(speakers[0].name, "ずんだもん");
        assert_eq!(
            speakers[0].styles,
            vec![SpeakerStyle {
                name: "ノーマル".into(),
                id: 3
            }]
        );
    }

    #[tokio::test]
    async fn synthesize_chains_query_into_synthesis() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio_query"))
            .and(query_param("text", "こんにちは"))
            .and(query_param("speaker", "3"))
            .respond_with(ResponseTemplate::new(200).set_body_json(sample_query()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/synthesis"))
            .and(query_param("speaker", "3"))
            .and(body_json(sample_query()))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"RIFFfake".to_vec()))
            .expect(1)
            .mount(&server)
            .await;

        let client = VoicevoxClient::new(&format!("{}/", server.uri())).unwrap();
        let out = client.synthesize("こんにちは", 3).await.unwrap();
        assert_eq!(out.query, sample_query());
        assert_eq!(out.wav, b"RIFFfake");
    }

    #[tokio::test]
    async fn reports_engine_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio_query"))
            .respond_with(ResponseTemplate::new(422).set_body_string("bad speaker"))
            .mount(&server)
            .await;

        let client = VoicevoxClient::new(&server.uri()).unwrap();
        let err = client.synthesize("x", 9999).await.unwrap_err();
        match err {
            Error::Status {
                endpoint, status, ..
            } => {
                assert_eq!(endpoint, "/audio_query");
                assert_eq!(status, 422);
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[tokio::test]
    async fn reports_unreachable_engine() {
        // Port 9 (discard) is almost never listening on loopback.
        let client = VoicevoxClient::new("http://127.0.0.1:9").unwrap();
        assert!(matches!(
            client.speakers().await,
            Err(Error::Unreachable { .. })
        ));
    }

    #[test]
    fn validates_base_url() {
        assert!(VoicevoxClient::new("ftp://example.com").is_err());
        assert!(VoicevoxClient::new("not a url").is_err());
        let client = VoicevoxClient::new(" http://localhost:50021/ ").unwrap();
        assert_eq!(client.base_url(), "http://localhost:50021");
        assert!(client.set_base_url("file:///etc/passwd").is_err());
        assert_eq!(client.base_url(), "http://localhost:50021");
    }

    #[test]
    fn pack_layout() {
        let s = Synthesis {
            query: json!({"a": 1}),
            wav: vec![1, 2, 3],
        };
        let packed = s.pack();
        let len = u32::from_le_bytes(packed[..4].try_into().unwrap()) as usize;
        assert_eq!(&packed[4..4 + len], br#"{"a":1}"#);
        assert_eq!(&packed[4 + len..], &[1, 2, 3]);
    }
}
