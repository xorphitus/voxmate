//! Minimal client for the VOICEVOX engine HTTP API.
//!
//! Only the endpoints voxmate needs: `GET /speakers`, `POST /audio_query`,
//! `POST /synthesis`, and `/mora_data`, `/mora_pitch` and `/mora_length` for
//! the scene editor's accent editing. The audio query is kept as raw JSON so fields added by
//! newer engine versions survive the round trip to `/synthesis` untouched.

use std::sync::RwLock;
use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct SpeakerStyle {
    /// Style name, e.g. ノーマル.
    pub name: String,
    /// What `speaker` takes elsewhere in the API.
    pub id: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Speaker {
    pub name: String,
    pub speaker_uuid: String,
    pub styles: Vec<SpeakerStyle>,
}

// Mirrored by `VoiceParams` in src/voice/params.ts.
/// How a line sounds. Each field overrides one `audio_query` value; omitted
/// fields keep what the engine chose. Ranges are those of the VOICEVOX editor.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParams {
    /// `speedScale`, 0.5 to 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 0.5, maximum = 2.0, example = 1.2)]
    pub speed: Option<f64>,
    /// `pitchScale`, -0.15 to 0.15.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(minimum = -0.15, maximum = 0.15)]
    pub pitch: Option<f64>,
    /// `intonationScale`, 0 to 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 0.0, maximum = 2.0)]
    pub intonation: Option<f64>,
    /// `volumeScale`, 0 to 2. The app volume applies on top.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 0.0, maximum = 2.0)]
    pub volume: Option<f64>,
    /// Silence before the line in seconds, 0 to 1.5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 0.0, maximum = 1.5)]
    pub pre_phoneme_length: Option<f64>,
    /// Silence after the line in seconds, 0 to 1.5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 0.0, maximum = 1.5)]
    pub post_phoneme_length: Option<f64>,
    /// Multiplies pauses between phrases, 0 to 2 (newer engines only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 0.0, maximum = 2.0)]
    pub pause_length_scale: Option<f64>,
}

impl VoiceParams {
    /// `(field name, audio_query key, value, min, max)` for each field.
    fn fields(&self) -> [(&'static str, &'static str, Option<f64>, f64, f64); 7] {
        [
            ("speed", "speedScale", self.speed, 0.5, 2.0),
            ("pitch", "pitchScale", self.pitch, -0.15, 0.15),
            ("intonation", "intonationScale", self.intonation, 0.0, 2.0),
            ("volume", "volumeScale", self.volume, 0.0, 2.0),
            (
                "prePhonemeLength",
                "prePhonemeLength",
                self.pre_phoneme_length,
                0.0,
                1.5,
            ),
            (
                "postPhonemeLength",
                "postPhonemeLength",
                self.post_phoneme_length,
                0.0,
                1.5,
            ),
            (
                "pauseLengthScale",
                "pauseLengthScale",
                self.pause_length_scale,
                0.0,
                2.0,
            ),
        ]
    }

    pub fn validate(&self) -> std::result::Result<(), String> {
        for (name, _, value, min, max) in self.fields() {
            if let Some(v) = value {
                if !(min..=max).contains(&v) {
                    return Err(format!("voice.{name} must be between {min} and {max}"));
                }
            }
        }
        Ok(())
    }

    /// Writes the set fields into an `audio_query`.
    pub fn apply(&self, query: &mut Value) {
        let Some(obj) = query.as_object_mut() else { return };
        for (_, key, value, _, _) in self.fields() {
            if let Some(v) = value {
                obj.insert(key.into(), v.into());
            }
        }
    }
}

/// Which mora values the engine recomputes after an accent edit.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MoraUpdate {
    /// Pitch and length (`/mora_data`).
    Data,
    Pitch,
    Length,
}

impl MoraUpdate {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Data => "/mora_data",
            Self::Pitch => "/mora_pitch",
            Self::Length => "/mora_length",
        }
    }
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

    async fn send(&self, endpoint: &'static str, req: reqwest::RequestBuilder) -> Result<reqwest::Response> {
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

    /// Recomputes the pitch and/or length of every mora in `accent_phrases`
    /// (the engine's JSON, passed through untouched) for `speaker`.
    pub async fn update_moras(&self, update: MoraUpdate, accent_phrases: &Value, speaker: u32) -> Result<Value> {
        let endpoint = update.endpoint();
        let req = self
            .http
            .post(self.endpoint(endpoint))
            .query(&[("speaker", speaker)])
            .json(accent_phrases);
        Ok(self.send(endpoint, req).await?.json().await?)
    }

    pub async fn synthesis(&self, query: &Value, speaker: u32) -> Result<Vec<u8>> {
        let req = self
            .http
            .post(self.endpoint("/synthesis"))
            .query(&[("speaker", speaker)])
            .json(query);
        Ok(self.send("/synthesis", req).await?.bytes().await?.to_vec())
    }

    /// Synthesizes `query` when given (an edited `audio_query`), or a fresh query
    /// for `text`. `voice` is written over the query's own values first.
    pub async fn synthesize(
        &self,
        text: &str,
        speaker: u32,
        voice: &VoiceParams,
        query: Option<Value>,
    ) -> Result<Synthesis> {
        let mut query = match query {
            Some(query) => query,
            None => self.audio_query(text, speaker).await?,
        };
        voice.apply(&mut query);
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
        let out = client
            .synthesize("こんにちは", 3, &VoiceParams::default(), None)
            .await
            .unwrap();
        assert_eq!(out.query, sample_query());
        assert_eq!(out.wav, b"RIFFfake");
    }

    #[tokio::test]
    async fn applies_voice_params_before_synthesis() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio_query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(sample_query()))
            .mount(&server)
            .await;
        let mut expected = sample_query();
        expected["speedScale"] = json!(1.5);
        expected["pitchScale"] = json!(-0.05);
        expected["prePhonemeLength"] = json!(0.0);
        Mock::given(method("POST"))
            .and(path("/synthesis"))
            .and(body_json(&expected))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"RIFFfake".to_vec()))
            .expect(1)
            .mount(&server)
            .await;

        let client = VoicevoxClient::new(&server.uri()).unwrap();
        let voice = VoiceParams {
            speed: Some(1.5),
            pitch: Some(-0.05),
            pre_phoneme_length: Some(0.0),
            ..Default::default()
        };
        let out = client.synthesize("x", 3, &voice, None).await.unwrap();
        // The returned query is what was synthesized, so lip sync follows it.
        assert_eq!(out.query, expected);
    }

    #[tokio::test]
    async fn updates_moras_through_the_chosen_endpoint() {
        let server = MockServer::start().await;
        let phrases =
            json!([{"moras": [{"text": "ア", "vowel": "a", "vowel_length": 0.1, "pitch": 5.0}], "accent": 1}]);
        let mut updated = phrases.clone();
        updated[0]["moras"][0]["pitch"] = json!(5.5);
        Mock::given(method("POST"))
            .and(path("/mora_pitch"))
            .and(query_param("speaker", "3"))
            .and(body_json(&phrases))
            .respond_with(ResponseTemplate::new(200).set_body_json(&updated))
            .expect(1)
            .mount(&server)
            .await;

        let client = VoicevoxClient::new(&server.uri()).unwrap();
        let out = client.update_moras(MoraUpdate::Pitch, &phrases, 3).await.unwrap();
        assert_eq!(out, updated);
        assert_eq!(
            serde_json::from_value::<MoraUpdate>(json!("data")).unwrap(),
            MoraUpdate::Data
        );
    }

    #[tokio::test]
    async fn synthesizes_a_given_query_without_asking_for_one() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio_query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(sample_query()))
            .expect(0)
            .mount(&server)
            .await;
        let mut edited = sample_query();
        edited["speedScale"] = json!(0.9);
        let mut expected = edited.clone();
        expected["pitchScale"] = json!(0.1);
        Mock::given(method("POST"))
            .and(path("/synthesis"))
            .and(body_json(&expected))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"RIFFfake".to_vec()))
            .expect(1)
            .mount(&server)
            .await;

        let client = VoicevoxClient::new(&server.uri()).unwrap();
        let voice = VoiceParams {
            pitch: Some(0.1),
            ..Default::default()
        };
        let out = client.synthesize("", 3, &voice, Some(edited)).await.unwrap();
        assert_eq!(out.query, expected);
    }

    #[tokio::test]
    async fn reports_a_rejected_query() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/synthesis"))
            .respond_with(ResponseTemplate::new(422).set_body_string("accent_phrases: field required"))
            .mount(&server)
            .await;

        let client = VoicevoxClient::new(&server.uri()).unwrap();
        let err = client
            .synthesize("", 3, &VoiceParams::default(), Some(json!({})))
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                Error::Status {
                    endpoint: "/synthesis",
                    status: 422,
                    ..
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn validates_voice_ranges() {
        assert!(VoiceParams::default().validate().is_ok());
        let ok = VoiceParams {
            speed: Some(0.5),
            pitch: Some(0.15),
            pause_length_scale: Some(2.0),
            ..Default::default()
        };
        assert!(ok.validate().is_ok());
        let too_fast = VoiceParams {
            speed: Some(2.5),
            ..Default::default()
        };
        assert_eq!(
            too_fast.validate().unwrap_err(),
            "voice.speed must be between 0.5 and 2"
        );
        let negative = VoiceParams {
            post_phoneme_length: Some(-0.1),
            ..Default::default()
        };
        assert!(negative.validate().is_err());
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
        let err = client
            .synthesize("x", 9999, &VoiceParams::default(), None)
            .await
            .unwrap_err();
        match err {
            Error::Status { endpoint, status, .. } => {
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
        assert!(matches!(client.speakers().await, Err(Error::Unreachable { .. })));
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
