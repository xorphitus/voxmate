//! Local HTTP API so other programs (scripts, LLM orchestrators, ...) can
//! make the characters speak and follow playback.
//!
//! The server binds to 127.0.0.1 only. On top of that it rejects requests
//! whose `Host` is not a loopback name (DNS rebinding) and only accepts
//! `application/json` bodies, which browsers cannot send cross-origin without
//! a CORS preflight that this server never approves.
//!
//! Lines are performed by the webview: requests are forwarded to it through
//! a [`Backend`], and it reports lifecycle events back into the
//! [`StageTracker`], which serves `GET /scenes/{id}` and `GET /events`.
//!
//! The OpenAPI spec is generated from the types and handlers below with
//! `utoipa`, served at `GET /openapi.json` and committed as
//! `docs/openapi.json` (a test fails when the two differ).

use std::convert::Infallible;
use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::stream::{self, Stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;
use utoipa::{OpenApi, ToSchema};

use crate::stage::{LineState, LineStatus, SceneStatus, StageEvent, StageTracker};
use crate::voicevox::{Speaker, VoiceParams};

pub const DEFAULT_PORT: u16 = 50080;
pub const MAX_TEXT_CHARS: usize = 2000;
pub const MAX_SCENE_LINES: usize = 200;
/// Speaker when no character has been saved yet; matches `DEFAULT_SPEAKER` in
/// src/characters.ts.
pub const DEFAULT_SPEAKER: u32 = 3;
/// Request bodies above this are rejected with 413. An `audio_query` for the
/// longest allowed text stays well below it.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// One line to perform. Mirrored by `LineRequest` in src/speech/LocalApiSource.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LineRequest {
    /// Text to speak. Leading and trailing whitespace is trimmed, and the
    /// trimmed text must be 1 to 2000 characters (Unicode scalar values).
    /// With `audioQuery` it is what the conversation log shows; it may then be
    /// omitted, and the query's `kana` is used instead.
    #[serde(default)]
    #[schema(example = "こんにちは", max_length = 2000)]
    pub text: String,
    /// Id of the character who speaks (`GET /characters`). Omit it to use
    /// the character on stage. An id the app doesn't know fails the line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(example = "default", pattern = "^[a-z0-9][a-z0-9_-]{0,63}$")]
    pub character: Option<String>,
    /// VOICEVOX style id (`GET /speakers`). Overrides the character's voice.
    /// Omit it to use the character's speaker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(example = 3)]
    pub speaker: Option<u32>,
    /// How the line sounds. Each field overrides the character's default,
    /// which overrides the engine's. With `audioQuery`, it overrides the
    /// query's values and the character's defaults are not applied.
    /// Out-of-range values are rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceParams>,
    /// A complete VOICEVOX `audio_query` (e.g. from `POST /audio_query`,
    /// edited) to synthesize as is, for control over accents, mora pitch and
    /// length, and pauses. Pitch values belong to the speaker the query was
    /// made for; another speaker works but sounds off. The engine's
    /// validation errors fail the line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub audio_query: Option<Value>,
    /// A stage direction, e.g. "(The topic changes to dinner.)": never
    /// spoken, only added to the conversation log. Needs `text`; can't have
    /// an `audioQuery`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub direction: bool,
}

/// Mirrors the id rule in src/characters.ts.
fn is_character_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    /// After everything already queued.
    #[default]
    Append,
    /// Right after the current line (and the rest of its scene), e.g. to
    /// interrupt an autonomous conversation.
    Next,
}

#[derive(Debug, Clone, PartialEq, Deserialize, ToSchema)]
pub struct SceneRequest {
    /// 1 to 200 lines, performed in order and kept together in the queue.
    #[schema(min_items = 1, max_items = 200)]
    pub lines: Vec<LineRequest>,
    #[serde(default)]
    pub placement: Placement,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct AudioQueryRequest {
    /// Text to make a query for, 1 to 2000 characters after trimming.
    #[schema(example = "こんにちは", min_length = 1, max_length = 2000)]
    pub text: String,
    /// Character whose speaker to use. Omit both this and `speaker` to use the
    /// character on stage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(example = "default", pattern = "^[a-z0-9][a-z0-9_-]{0,63}$")]
    pub character: Option<String>,
    /// VOICEVOX style id; wins over `character`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(example = 3)]
    pub speaker: Option<u32>,
}

/// A line with the id it was given, as sent to the webview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedLine {
    pub id: String,
    #[serde(flatten)]
    pub line: LineRequest,
}

/// What the webview is asked to queue. Mirrored in src/speech/LocalApiSource.ts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    /// None for a single `/speak` line, which belongs to no scene.
    pub scene_id: Option<String>,
    pub placement: Placement,
    pub lines: Vec<SubmittedLine>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SpeakStatus {
    Queued,
}

/// The line was queued. It is spoken after anything already in the queue,
/// so this does not mean it has been spoken; follow `lineId` on `GET /events`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpeakAccepted {
    pub status: SpeakStatus,
    pub line_id: String,
}

/// The scene was queued. Follow it with `GET /scenes/{id}` or `GET /events`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SceneAccepted {
    pub id: String,
    /// In the order of the request's `lines`.
    pub line_ids: Vec<String>,
}

/// A character as set up in the app.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInfo {
    #[schema(example = "default")]
    pub id: String,
    pub name: String,
    /// VOICEVOX style id.
    pub speaker: u32,
    /// Default voice parameters; lines override them.
    pub voice: VoiceParams,
    /// Whether this is the character on stage, used by lines that name none.
    pub on_stage: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ApiError {
    /// Human-readable reason.
    #[schema(example = "text must not be empty")]
    pub error: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Health {
    pub ok: bool,
    #[schema(example = "voxmate")]
    pub name: String,
    /// voxmate version.
    #[schema(example = "0.1.0")]
    pub version: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum QueryError {
    /// The request named a character the app doesn't have.
    UnknownCharacter(String),
    /// The engine could not be reached or refused.
    Engine(String),
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// The app side of the API (in the app: the webview, the settings store and
/// the VOICEVOX client).
pub trait Backend: Send + Sync {
    /// The webview is listening for submissions.
    fn ready(&self) -> bool;
    fn submit(&self, submission: Submission);
    fn cancel_scene(&self, id: &str);
    fn characters(&self) -> Vec<CharacterInfo>;
    fn speakers(&self) -> BoxFuture<Result<Vec<Speaker>, String>>;
    fn audio_query(&self, req: AudioQueryRequest) -> BoxFuture<Result<Value, QueryError>>;
}

#[derive(Clone)]
pub struct ApiState {
    pub backend: Arc<dyn Backend>,
    pub tracker: Arc<StageTracker>,
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    let body = ApiError { error: message.into() };
    (status, Json(body)).into_response()
}

fn not_ready() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "voxmate is still starting; try again shortly",
    )
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn validate_text(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("text must not be empty".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("text is longer than {MAX_TEXT_CHARS} characters"));
    }
    Ok(text)
}

fn validate_character(character: &Option<String>) -> Result<(), String> {
    match character {
        Some(id) if !is_character_id(id) => {
            Err("character must be 1-64 characters of a-z, 0-9, - and _, starting with a letter or digit".into())
        }
        _ => Ok(()),
    }
}

pub fn validate(req: LineRequest) -> Result<LineRequest, String> {
    if let Some(query) = &req.audio_query {
        if req.direction {
            return Err("a stage direction can't have an audioQuery".into());
        }
        if !query.get("accent_phrases").is_some_and(Value::is_array) {
            return Err("audioQuery must be an object with an accent_phrases array".into());
        }
    }
    // With a query, fall back to its kana so the log has something to show.
    let kana = req
        .audio_query
        .as_ref()
        .and_then(|q| q.get("kana"))
        .and_then(Value::as_str);
    let text = match (req.text.trim(), kana) {
        ("", Some(kana)) => kana,
        _ => &req.text,
    };
    let text = validate_text(text)?;
    validate_character(&req.character)?;
    if let Some(voice) = &req.voice {
        voice.validate()?;
    }
    Ok(LineRequest {
        text: text.to_string(),
        ..req
    })
}

pub fn validate_scene(req: SceneRequest) -> Result<SceneRequest, String> {
    if req.lines.is_empty() {
        return Err("lines must not be empty".into());
    }
    if req.lines.len() > MAX_SCENE_LINES {
        return Err(format!("a scene has at most {MAX_SCENE_LINES} lines"));
    }
    let lines = req
        .lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| validate(line).map_err(|e| format!("lines[{i}]: {e}")))
        .collect::<Result<_, _>>()?;
    Ok(SceneRequest { lines, ..req })
}

pub fn validate_query_request(req: AudioQueryRequest) -> Result<AudioQueryRequest, String> {
    let text = validate_text(&req.text)?.to_string();
    validate_character(&req.character)?;
    Ok(AudioQueryRequest { text, ..req })
}

fn character_list(characters: Option<&Value>) -> &[Value] {
    characters
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn speaker_of(character: &Value) -> u32 {
    character
        .get("speaker")
        .and_then(Value::as_u64)
        .and_then(|s| u32::try_from(s).ok())
        .unwrap_or(DEFAULT_SPEAKER)
}

/// The id of the character on stage: the saved default if it exists, else
/// the first character (as `resolveCharacter` in src/characters.ts does).
fn on_stage_id<'a>(list: &'a [Value], default: Option<&str>) -> Option<&'a str> {
    let ids = || list.iter().filter_map(|c| c.get("id").and_then(Value::as_str));
    ids().find(|id| Some(*id) == default).or_else(|| ids().next())
}

/// The speaker for `/audio_query`, from the `characters` and
/// `defaultCharacter` settings. A named character must exist.
pub fn resolve_speaker(characters: Option<&Value>, default: Option<&str>, id: Option<&str>) -> Result<u32, QueryError> {
    let list = character_list(characters);
    let wanted = match id {
        Some(id) => id,
        // Before the app has saved any character: the app's default voice.
        None => match on_stage_id(list, default) {
            Some(id) => id,
            None => return Ok(DEFAULT_SPEAKER),
        },
    };
    list.iter()
        .find(|c| c.get("id").and_then(Value::as_str) == Some(wanted))
        .map(speaker_of)
        .ok_or_else(|| QueryError::UnknownCharacter(wanted.to_string()))
}

/// `GET /characters` from the saved settings; entries without an id are skipped.
pub fn character_infos(characters: Option<&Value>, default: Option<&str>) -> Vec<CharacterInfo> {
    let list = character_list(characters);
    let on_stage = on_stage_id(list, default);
    list.iter()
        .filter_map(|c| {
            let id = c.get("id")?.as_str()?;
            Some(CharacterInfo {
                id: id.to_string(),
                name: c.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
                speaker: speaker_of(c),
                voice: c
                    .get("voice")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default(),
                on_stage: Some(id) == on_stage,
            })
        })
        .collect()
}

/// One stderr line per accepted request. Lets a client that re-sends text be
/// told apart from the app speaking something twice. The text itself is not
/// logged, only its length and hash.
fn log_request(client: Option<SocketAddr>, path: &str, lines: &[LineRequest]) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64());
    let client = client.map_or_else(|| "unknown".to_string(), |addr| addr.to_string());
    for req in lines {
        let mut hasher = DefaultHasher::new();
        req.text.hash(&mut hasher);
        eprintln!(
            "[{now:.3}] POST {path} from {client}: {} chars, hash {:016x}, character {:?}, speaker {:?}, audio query {}",
            req.text.chars().count(),
            hasher.finish(),
            req.character,
            req.speaker,
            req.audio_query.is_some(),
        );
    }
}

fn client_addr(client: Option<Extension<ConnectInfo<SocketAddr>>>) -> Option<SocketAddr> {
    client.map(|Extension(ConnectInfo(addr))| addr)
}

/// Queue one line.
///
/// Lines from the API and the app share one queue, so they never overlap.
/// The response is sent as soon as the line is queued. For several lines that
/// belong together, use `POST /scenes`.
#[utoipa::path(
    post,
    path = "/speak",
    request_body(content = LineRequest, content_type = "application/json"),
    responses(
        (status = 202, description = "Queued (not yet spoken)", body = SpeakAccepted),
        (status = 400, description = "Blank or too long text, a malformed character id, an out-of-range voice parameter, a bad `audioQuery`, or malformed JSON", body = ApiError),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
        (status = 413, description = "Body larger than 1 MiB", body = ApiError),
        (status = 415, description = "Content type is not `application/json`", body = ApiError),
        (status = 422, description = "JSON does not match `LineRequest`", body = ApiError),
        (status = 503, description = "The app is still starting", body = ApiError),
    )
)]
async fn speak(
    State(state): State<ApiState>,
    client: Option<Extension<ConnectInfo<SocketAddr>>>,
    body: Result<Json<LineRequest>, JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return error(rejection.status(), rejection.body_text()),
    };
    let line = match validate(req) {
        Ok(line) => line,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    if !state.backend.ready() {
        return not_ready();
    }
    log_request(client_addr(client), "/speak", std::slice::from_ref(&line));
    let id = new_id();
    state.backend.submit(Submission {
        scene_id: None,
        placement: Placement::Append,
        lines: vec![SubmittedLine { id: id.clone(), line }],
    });
    let body = SpeakAccepted {
        status: SpeakStatus::Queued,
        line_id: id,
    };
    (StatusCode::ACCEPTED, Json(body)).into_response()
}

/// Queue a scene: several lines, possibly by different characters.
///
/// The lines are performed in order and stay together in the queue. Follow
/// them with `GET /scenes/{id}` or `GET /events`, and cancel the rest with
/// `DELETE /scenes/{id}`.
#[utoipa::path(
    post,
    path = "/scenes",
    request_body(content = SceneRequest, content_type = "application/json"),
    responses(
        (status = 202, description = "Queued (not yet spoken)", body = SceneAccepted),
        (status = 400, description = "No lines, more than 200, or a line `/speak` would reject (the message names it, e.g. `lines[2]: ...`)", body = ApiError),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
        (status = 413, description = "Body larger than 1 MiB", body = ApiError),
        (status = 415, description = "Content type is not `application/json`", body = ApiError),
        (status = 422, description = "JSON does not match `SceneRequest`", body = ApiError),
        (status = 503, description = "The app is still starting", body = ApiError),
    )
)]
async fn post_scene(
    State(state): State<ApiState>,
    client: Option<Extension<ConnectInfo<SocketAddr>>>,
    body: Result<Json<SceneRequest>, JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return error(rejection.status(), rejection.body_text()),
    };
    let scene = match validate_scene(req) {
        Ok(scene) => scene,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    if !state.backend.ready() {
        return not_ready();
    }
    log_request(client_addr(client), "/scenes", &scene.lines);
    let id = new_id();
    let lines: Vec<SubmittedLine> = scene
        .lines
        .into_iter()
        .map(|line| SubmittedLine { id: new_id(), line })
        .collect();
    state.tracker.add_scene(SceneStatus {
        id: id.clone(),
        finished: false,
        lines: lines
            .iter()
            .map(|l| LineStatus {
                id: l.id.clone(),
                character: l.line.character.clone(),
                text: l.line.text.clone(),
                state: LineState::Queued,
                error: None,
            })
            .collect(),
    });
    let line_ids = lines.iter().map(|l| l.id.clone()).collect();
    state.backend.submit(Submission {
        scene_id: Some(id.clone()),
        placement: scene.placement,
        lines,
    });
    (StatusCode::ACCEPTED, Json(SceneAccepted { id, line_ids })).into_response()
}

/// The state of each line of a scene.
///
/// The 100 most recent scenes are kept.
#[utoipa::path(
    get,
    path = "/scenes/{id}",
    params(("id" = String, Path, description = "Scene id from `POST /scenes`")),
    responses(
        (status = 200, description = "Scene status", body = SceneStatus),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
        (status = 404, description = "Unknown or forgotten scene", body = ApiError),
    )
)]
async fn get_scene(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.tracker.scene(&id) {
        Some(scene) => Json(scene).into_response(),
        None => error(StatusCode::NOT_FOUND, format!("unknown scene \"{id}\"")),
    }
}

/// Cancel the rest of a scene.
///
/// Lines not yet spoken are skipped, and the current line is interrupted if
/// it belongs to the scene. Cancelling happens in the app shortly after the
/// response; the returned status may still show lines as queued.
#[utoipa::path(
    delete,
    path = "/scenes/{id}",
    params(("id" = String, Path, description = "Scene id from `POST /scenes`")),
    responses(
        (status = 202, description = "Cancelling", body = SceneStatus),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
        (status = 404, description = "Unknown or forgotten scene", body = ApiError),
        (status = 503, description = "The app is still starting", body = ApiError),
    )
)]
async fn delete_scene(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let Some(scene) = state.tracker.scene(&id) else {
        return error(StatusCode::NOT_FOUND, format!("unknown scene \"{id}\""));
    };
    if !state.backend.ready() {
        return not_ready();
    }
    state.backend.cancel_scene(&id);
    (StatusCode::ACCEPTED, Json(scene)).into_response()
}

fn sse_event(event: StageEvent) -> Event {
    let (name, data) = match &event {
        StageEvent::Line(e) => ("line", serde_json::to_string(e)),
        StageEvent::Log(e) => ("log", serde_json::to_string(e)),
    };
    Event::default()
        .event(name)
        .data(data.expect("events always serialize"))
}

fn event_stream(rx: broadcast::Receiver<StageEvent>) -> impl Stream<Item = Result<Event, Infallible>> {
    stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => return Some((Ok(sse_event(event)), rx)),
                // A slow client misses some events rather than stalling others.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

/// Stream of playback events (Server-Sent Events).
///
/// Every line from every producer (API, UI, LLM) is reported:
/// - `event: line`, data `LineEvent`: a line changed state
///   (`queued → preparing → speaking → done | interrupted | skipped | failed`).
/// - `event: log`, data `LogEntry`: a line was heard and added to the
///   conversation log.
///
/// Only events after the connection opens are sent.
#[utoipa::path(
    get,
    path = "/events",
    responses(
        (status = 200, description = "`text/event-stream` of `line` (LineEvent) and `log` (LogEntry) events", content_type = "text/event-stream", body = String),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
    )
)]
async fn events(State(state): State<ApiState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    Sse::new(event_stream(state.tracker.subscribe())).keep_alive(KeepAlive::default())
}

/// The characters set up in the app.
#[utoipa::path(
    get,
    path = "/characters",
    responses(
        (status = 200, description = "Characters", body = Vec<CharacterInfo>),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
    )
)]
async fn characters(State(state): State<ApiState>) -> Json<Vec<CharacterInfo>> {
    Json(state.backend.characters())
}

/// The VOICEVOX engine's speakers and their styles.
///
/// A style's `id` is what `speaker` takes elsewhere.
#[utoipa::path(
    get,
    path = "/speakers",
    responses(
        (status = 200, description = "Speakers", body = Vec<Speaker>),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
        (status = 502, description = "The VOICEVOX engine is unreachable or failed", body = ApiError),
    )
)]
async fn speakers(State(state): State<ApiState>) -> Response {
    match state.backend.speakers().await {
        Ok(speakers) => Json(speakers).into_response(),
        Err(message) => error(StatusCode::BAD_GATEWAY, message),
    }
}

/// Make a VOICEVOX `audio_query` to edit.
///
/// Returns the engine's query for the text, unchanged. Edit it and send it
/// back as `audioQuery` in `POST /speak` or a scene line, so clients need
/// not know the engine's URL.
#[utoipa::path(
    post,
    path = "/audio_query",
    request_body(content = AudioQueryRequest, content_type = "application/json"),
    responses(
        (status = 200, description = "The engine's `audio_query`", content_type = "application/json"),
        (status = 400, description = "Blank or too long text, a malformed character id, or malformed JSON", body = ApiError),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
        (status = 404, description = "No character with that id", body = ApiError),
        (status = 413, description = "Body larger than 1 MiB", body = ApiError),
        (status = 415, description = "Content type is not `application/json`", body = ApiError),
        (status = 422, description = "JSON does not match `AudioQueryRequest`", body = ApiError),
        (status = 502, description = "The VOICEVOX engine is unreachable or failed", body = ApiError),
    )
)]
async fn audio_query(State(state): State<ApiState>, body: Result<Json<AudioQueryRequest>, JsonRejection>) -> Response {
    let Json(req) = match body {
        Ok(body) => body,
        Err(rejection) => return error(rejection.status(), rejection.body_text()),
    };
    let req = match validate_query_request(req) {
        Ok(req) => req,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    match state.backend.audio_query(req).await {
        Ok(query) => Json(query).into_response(),
        Err(QueryError::UnknownCharacter(id)) => error(StatusCode::NOT_FOUND, format!("unknown character \"{id}\"")),
        Err(QueryError::Engine(message)) => error(StatusCode::BAD_GATEWAY, message),
    }
}

/// Check that voxmate is running.
#[utoipa::path(
    get,
    path = "/health",
    responses(
        (status = 200, description = "Running", body = Health),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
    )
)]
async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        name: "voxmate".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    })
}

/// This OpenAPI document.
#[utoipa::path(
    get,
    path = "/openapi.json",
    responses(
        (status = 200, description = "OpenAPI document", content_type = "application/json"),
        (status = 403, description = "`Host` is not a loopback name", body = ApiError),
    )
)]
async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "voxmate Local API",
        description = "Make voxmate's characters speak, perform multi-character scenes and follow playback. Listens on 127.0.0.1 only (port 50080 by default, configurable in the app). Every request needs a loopback `Host` header (`127.0.0.1`, `localhost` or `[::1]`). CORS preflights are never answered, so web pages on other origins cannot call it."
    ),
    servers((url = "http://127.0.0.1:50080", description = "Default port")),
    paths(speak, post_scene, get_scene, delete_scene, events, characters, speakers, audio_query, health, openapi_json),
    components(schemas(crate::stage::LineEvent, crate::stage::LogEntry))
)]
pub struct ApiDoc;

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

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/speak", post(speak))
        .route("/scenes", post(post_scene))
        .route("/scenes/{id}", get(get_scene).delete(delete_scene))
        .route("/events", get(events))
        .route("/characters", get(characters))
        .route("/speakers", get(speakers))
        .route("/audio_query", post(audio_query))
        .route("/health", get(health))
        .route("/openapi.json", get(openapi_json))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(require_loopback_host))
        .with_state(state)
}

/// Binds synchronously so a port conflict can be reported at startup.
pub fn bind(port: u16) -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Must be called from inside a tokio runtime.
pub async fn serve(listener: TcpListener, state: ApiState) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stage::LineEvent;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tower::ServiceExt;

    /// Records what the API asks of the app. `audio_query` echoes the text as
    /// `kana`; "down" fails like an unreachable engine.
    struct Fake {
        ready: AtomicBool,
        submissions: Mutex<Vec<Submission>>,
        cancelled: Mutex<Vec<String>>,
        tracker: Arc<StageTracker>,
    }

    impl Fake {
        /// Every submitted line, scenes flattened.
        fn lines(&self) -> Vec<LineRequest> {
            let submissions = self.submissions.lock().unwrap();
            submissions
                .iter()
                .flat_map(|s| s.lines.iter().map(|l| l.line.clone()))
                .collect()
        }
    }

    impl Backend for Fake {
        fn ready(&self) -> bool {
            self.ready.load(Ordering::SeqCst)
        }
        fn submit(&self, submission: Submission) {
            self.submissions.lock().unwrap().push(submission);
        }
        fn cancel_scene(&self, id: &str) {
            self.cancelled.lock().unwrap().push(id.to_string());
        }
        fn characters(&self) -> Vec<CharacterInfo> {
            let list = json!([{ "id": "zunda", "name": "ずんだもん", "speaker": 3, "voice": { "speed": 1.1 } }]);
            character_infos(Some(&list), Some("zunda"))
        }
        fn speakers(&self) -> BoxFuture<Result<Vec<Speaker>, String>> {
            Box::pin(async { Err("cannot reach VOICEVOX engine".into()) })
        }
        fn audio_query(&self, req: AudioQueryRequest) -> BoxFuture<Result<Value, QueryError>> {
            Box::pin(async move {
                if req.character.as_deref() == Some("nobody") {
                    return Err(QueryError::UnknownCharacter("nobody".into()));
                }
                if req.text == "down" {
                    return Err(QueryError::Engine("cannot reach VOICEVOX engine".into()));
                }
                Ok(json!({ "accent_phrases": [], "kana": req.text, "speaker": req.speaker }))
            })
        }
    }

    fn capture() -> (Arc<Fake>, Arc<Fake>) {
        let fake = Arc::new(Fake {
            ready: AtomicBool::new(true),
            submissions: Mutex::default(),
            cancelled: Mutex::default(),
            tracker: Arc::default(),
        });
        (fake.clone(), fake)
    }

    fn state(fake: Arc<Fake>) -> ApiState {
        ApiState {
            tracker: fake.tracker.clone(),
            backend: fake,
        }
    }

    /// Shadows `super::router` so the tests only pass the fake.
    fn router(fake: Arc<Fake>) -> Router {
        super::router(state(fake))
    }

    fn post_json(path: &str, body: &str) -> Request<Body> {
        Request::post(path)
            .header(header::HOST, "127.0.0.1:50080")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn request(method: &str, path: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "localhost:50080")
            .body(Body::empty())
            .unwrap()
    }

    fn two_line_scene() -> Value {
        json!({ "lines": [
            { "character": "zunda", "text": "こんにちは" },
            { "character": "metan", "text": "こんにちは、ずんだもん", "voice": { "speed": 1.1 } },
        ] })
    }

    fn line_event(line_id: &str, scene_id: &str, state: LineState) -> StageEvent {
        StageEvent::Line(LineEvent {
            line_id: line_id.into(),
            scene_id: Some(scene_id.into()),
            character: "zunda".into(),
            text: "こんにちは".into(),
            source: "api".into(),
            state,
            error: None,
        })
    }

    #[tokio::test]
    async fn queues_a_scene_with_ids() {
        let (fake, _) = capture();
        let res = router(fake.clone())
            .oneshot(post_json("/scenes", &two_line_scene().to_string()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        let body = body_json(res).await;
        let submissions = fake.submissions.lock().unwrap();
        let submitted = &submissions[0];
        assert_eq!(submitted.scene_id.as_deref(), body["id"].as_str());
        assert_eq!(submitted.placement, Placement::Append);
        let ids: Vec<&str> = submitted.lines.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(body["lineIds"], json!(ids));
        assert_eq!(submitted.lines[1].line.character.as_deref(), Some("metan"));
    }

    #[tokio::test]
    async fn queues_a_scene_next() {
        let (fake, _) = capture();
        let mut scene = two_line_scene();
        scene["placement"] = json!("next");
        let res = router(fake.clone())
            .oneshot(post_json("/scenes", &scene.to_string()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(fake.submissions.lock().unwrap()[0].placement, Placement::Next);
    }

    #[tokio::test]
    async fn rejects_bad_scenes() {
        let (fake, _) = capture();
        let too_many = json!({ "lines": vec![json!({ "text": "a" }); MAX_SCENE_LINES + 1] });
        let cases = [
            (json!({ "lines": [] }), "lines must not be empty"),
            (too_many, "a scene has at most 200 lines"),
            (
                json!({ "lines": [{ "text": "a" }, { "text": " " }] }),
                "lines[1]: text must not be empty",
            ),
            (
                json!({ "lines": [{ "direction": true, "audioQuery": { "accent_phrases": [] }, "text": "a" }] }),
                "lines[0]: a stage direction can't have an audioQuery",
            ),
        ];
        for (scene, message) in cases {
            let res = router(fake.clone())
                .oneshot(post_json("/scenes", &scene.to_string()))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST);
            assert_eq!(body_json(res).await, json!({ "error": message }));
        }
        assert!(fake.lines().is_empty());
    }

    #[tokio::test]
    async fn answers_503_until_the_app_is_ready() {
        let (fake, _) = capture();
        fake.ready.store(false, Ordering::SeqCst);
        for (path, body) in [("/speak", json!({ "text": "a" })), ("/scenes", two_line_scene())] {
            let res = router(fake.clone())
                .oneshot(post_json(path, &body.to_string()))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE, "{path}");
        }
        assert!(fake.lines().is_empty());
    }

    #[tokio::test]
    async fn reports_and_cancels_a_scene() {
        let (fake, _) = capture();
        let res = router(fake.clone())
            .oneshot(post_json("/scenes", &two_line_scene().to_string()))
            .await
            .unwrap();
        let body = body_json(res).await;
        let id = body["id"].as_str().unwrap();
        let first = body["lineIds"][0].as_str().unwrap();

        fake.tracker.record(line_event(first, id, LineState::Speaking));
        let res = router(fake.clone())
            .oneshot(request("GET", &format!("/scenes/{id}")))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let status = body_json(res).await;
        assert_eq!(status["lines"][0]["state"], json!("speaking"));
        assert_eq!(status["lines"][1]["state"], json!("queued"));
        assert_eq!(status["finished"], json!(false));

        let res = router(fake.clone())
            .oneshot(request("DELETE", &format!("/scenes/{id}")))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(*fake.cancelled.lock().unwrap(), vec![id.to_string()]);
    }

    #[tokio::test]
    async fn unknown_scenes_are_404() {
        let (fake, _) = capture();
        for method in ["GET", "DELETE"] {
            let res = router(fake.clone())
                .oneshot(request(method, "/scenes/nope"))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{method}");
        }
        assert!(fake.cancelled.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn streams_events() {
        let (fake, _) = capture();
        let res = router(fake.clone()).oneshot(request("GET", "/events")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/event-stream");
        // The handler has subscribed by the time the response exists.
        fake.tracker.record(line_event("l1", "s1", LineState::Done));
        let mut body = res.into_body();
        let frame = body.frame().await.unwrap().unwrap().into_data().unwrap();
        let text = String::from_utf8(frame.to_vec()).unwrap();
        assert!(text.starts_with("event: line\ndata: {"), "{text}");
        assert!(
            text.contains(r#""lineId":"l1""#) && text.contains(r#""state":"done""#),
            "{text}"
        );
    }

    #[tokio::test]
    async fn events_require_a_loopback_host() {
        let (fake, _) = capture();
        let req = Request::get("/events")
            .header(header::HOST, "evil.example")
            .body(Body::empty())
            .unwrap();
        let res = router(fake).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn lists_characters() {
        let (fake, _) = capture();
        let res = router(fake).oneshot(request("GET", "/characters")).await.unwrap();
        assert_eq!(
            body_json(res).await,
            json!([{ "id": "zunda", "name": "ずんだもん", "speaker": 3, "voice": { "speed": 1.1 }, "onStage": true }])
        );
    }

    #[tokio::test]
    async fn reports_an_unreachable_engine_for_speakers() {
        let (fake, _) = capture();
        let res = router(fake).oneshot(request("GET", "/speakers")).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn character_infos_from_settings() {
        let list = json!([{ "id": "a" }, { "name": "no id" }, { "id": "b", "speaker": 8, "voice": { "speed": "x" } }]);
        let infos = character_infos(Some(&list), Some("gone"));
        assert_eq!(infos.len(), 2);
        assert_eq!(
            (infos[0].name.as_str(), infos[0].speaker, infos[0].on_stage),
            ("a", DEFAULT_SPEAKER, true)
        );
        assert_eq!((infos[1].speaker, infos[1].on_stage), (8, false));
        assert_eq!(infos[1].voice, VoiceParams::default());
    }

    #[tokio::test]
    async fn speaks_an_audio_query_with_kana_as_text() {
        let (sink, got) = capture();
        let body = json!({ "audioQuery": { "accent_phrases": [], "kana": "コンニチワ'" }, "speaker": 1 });
        let res = router(sink)
            .oneshot(post_json("/speak", &body.to_string()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        let got = got.lines();
        assert_eq!(got[0].text, "コンニチワ'");
        assert_eq!(got[0].audio_query, Some(body["audioQuery"].clone()));
    }

    #[tokio::test]
    async fn keeps_given_text_alongside_an_audio_query() {
        let (sink, got) = capture();
        let body = json!({ "text": "こんにちは", "audioQuery": { "accent_phrases": [], "kana": "コンニチワ'" } });
        let res = router(sink)
            .oneshot(post_json("/speak", &body.to_string()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(got.lines()[0].text, "こんにちは");
    }

    #[tokio::test]
    async fn rejects_an_audio_query_without_accent_phrases() {
        let (sink, got) = capture();
        for query in [json!({ "kana": "ア" }), json!([]), json!("x")] {
            let body = json!({ "text": "a", "audioQuery": query });
            let res = router(sink.clone())
                .oneshot(post_json("/speak", &body.to_string()))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{query}");
        }
        // Neither text nor kana.
        let body = json!({ "audioQuery": { "accent_phrases": [] } });
        let res = router(sink)
            .oneshot(post_json("/speak", &body.to_string()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(got.lines().is_empty());
    }

    #[tokio::test]
    async fn rejects_bodies_over_the_limit() {
        let (sink, _) = capture();
        let padding = "a".repeat(MAX_BODY_BYTES);
        let body = json!({ "text": "a", "audioQuery": { "accent_phrases": [], "pad": padding } });
        let res = router(sink)
            .oneshot(post_json("/speak", &body.to_string()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn returns_an_audio_query() {
        let (sink, _) = capture();
        let res = router(sink)
            .oneshot(post_json("/audio_query", r#"{"text":" こんにちは ","speaker":1}"#))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            body_json(res).await,
            json!({ "accent_phrases": [], "kana": "こんにちは", "speaker": 1 })
        );
    }

    #[tokio::test]
    async fn audio_query_errors() {
        let (sink, _) = capture();
        let cases = [
            (r#"{"text":" "}"#, StatusCode::BAD_REQUEST),
            (r#"{"text":"a","character":"Bad"}"#, StatusCode::BAD_REQUEST),
            (r#"{"text":"a","character":"nobody"}"#, StatusCode::NOT_FOUND),
            (r#"{"text":"down"}"#, StatusCode::BAD_GATEWAY),
            (r#"{"speaker":1}"#, StatusCode::UNPROCESSABLE_ENTITY),
        ];
        for (body, status) in cases {
            let res = router(sink.clone())
                .oneshot(post_json("/audio_query", body))
                .await
                .unwrap();
            assert_eq!(res.status(), status, "{body}");
        }
    }

    #[test]
    fn resolves_speakers_like_the_app() {
        let characters = json!([{ "id": "a", "speaker": 1 }, { "id": "b", "speaker": 8 }]);
        let c = Some(&characters);
        assert_eq!(resolve_speaker(c, Some("a"), Some("b")), Ok(8));
        assert_eq!(resolve_speaker(c, Some("b"), None), Ok(8));
        assert_eq!(resolve_speaker(c, Some("gone"), None), Ok(1));
        assert_eq!(
            resolve_speaker(c, Some("a"), Some("nobody")),
            Err(QueryError::UnknownCharacter("nobody".into()))
        );
        assert_eq!(resolve_speaker(None, None, None), Ok(DEFAULT_SPEAKER));
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
                r#"{"text":"  こんにちは ","character":"zunda-1","speaker":3,"voice":{"speed":1.3,"pitch":0.05}}"#,
                "application/json",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        let body = body_json(res).await;
        assert_eq!(body["status"], json!("queued"));
        assert!(body["lineId"].is_string());
        assert_eq!(
            *got.lines(),
            vec![LineRequest {
                text: "こんにちは".into(),
                character: Some("zunda-1".into()),
                speaker: Some(3),
                voice: Some(VoiceParams {
                    speed: Some(1.3),
                    pitch: Some(0.05),
                    ..Default::default()
                }),
                audio_query: None,
                direction: false,
            }]
        );
    }

    #[tokio::test]
    async fn character_and_speaker_are_optional() {
        let (sink, got) = capture();
        let res = router(sink)
            .oneshot(post_speak(r#"{"text":"hi"}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        let got = got.lines();
        assert_eq!(got[0].character, None);
        assert_eq!(got[0].speaker, None);
    }

    #[tokio::test]
    async fn rejects_out_of_range_voice() {
        let (sink, got) = capture();
        let res = router(sink)
            .oneshot(post_speak(r#"{"text":"hi","voice":{"speed":3}}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(res).await,
            json!({"error": "voice.speed must be between 0.5 and 2"})
        );
        assert!(got.lines().is_empty());
    }

    #[tokio::test]
    async fn rejects_malformed_character_id() {
        for id in ["", "Zunda", "-a", "a b", &"a".repeat(65)] {
            let (sink, got) = capture();
            let res = router(sink)
                .oneshot(post_speak(
                    &json!({ "text": "hi", "character": id }).to_string(),
                    "application/json",
                ))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{id:?}");
            assert!(got.lines().is_empty());
        }
    }

    #[tokio::test]
    async fn rejects_blank_text() {
        let (sink, got) = capture();
        let res = router(sink)
            .oneshot(post_speak(r#"{"text":"   "}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(got.lines().is_empty());
    }

    #[tokio::test]
    async fn rejects_too_long_text() {
        let (sink, _) = capture();
        let long = "あ".repeat(MAX_TEXT_CHARS + 1);
        let res = router(sink)
            .oneshot(post_speak(&json!({ "text": long }).to_string(), "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn rejects_malformed_json() {
        let (sink, _) = capture();
        let res = router(sink.clone())
            .oneshot(post_speak(r#"{"text":1}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

        // Without text or an audioQuery there is nothing to say.
        let res = router(sink.clone())
            .oneshot(post_speak(r#"{"speaker":1}"#, "application/json"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

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
        assert!(got.lines().is_empty());
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
        assert!(got.lines().is_empty());
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

    #[tokio::test]
    async fn serves_openapi() {
        let (sink, _) = capture();
        let req = Request::get("/openapi.json")
            .header(header::HOST, "localhost:50080")
            .body(Body::empty())
            .unwrap();
        let res = router(sink).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let spec = body_json(res).await;
        assert!(spec["paths"]["/speak"]["post"].is_object());
    }

    /// The committed spec is for reading without the app running, so it must
    /// match the generated one. `UPDATE_OPENAPI=1 cargo test` rewrites it.
    #[test]
    fn committed_openapi_is_up_to_date() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/openapi.json");
        let generated = ApiDoc::openapi().to_pretty_json().unwrap() + "\n";
        if std::env::var_os("UPDATE_OPENAPI").is_some() {
            std::fs::write(path, &generated).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(path).unwrap_or_default();
        assert!(
            committed == generated,
            "docs/openapi.json is stale; run `UPDATE_OPENAPI=1 cargo test api::` in src-tauri"
        );
    }

    #[test]
    fn spec_text_limit_matches_validation() {
        let spec = serde_json::to_value(ApiDoc::openapi()).unwrap();
        let text = &spec["components"]["schemas"]["LineRequest"]["properties"]["text"];
        assert_eq!(text["maxLength"], json!(MAX_TEXT_CHARS));
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
        tokio::spawn(serve(listener, state(sink)));

        let res = reqwest::Client::new()
            .post(format!("http://{addr}/speak"))
            .json(&json!({"text": "テスト"}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 202);
        assert_eq!(got.lines()[0].text, "テスト");
    }
}
