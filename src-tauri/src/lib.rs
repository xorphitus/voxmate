mod api;
mod llm;
mod stage;
mod voicevox;
mod wav;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use crate::llm::{ChatMessage, LlmClient};
use crate::stage::{Capabilities, StageEvent, StageTracker};
use crate::voicevox::{MoraUpdate, Speaker, VoiceParams, VoicevoxClient};

/// Shared with the frontend (`src/config.ts`), which owns writing it.
const SETTINGS_FILE: &str = "settings.json";
/// Lines from the Local API for the webview to queue (`api::Submission`).
const SUBMIT_EVENT: &str = "stage-submit";
/// A scene id whose remaining lines the webview should drop.
const CANCEL_SCENE_EVENT: &str = "stage-cancel-scene";

/// Settings that must be known before the webview exists.
struct StartupSettings {
    voicevox_url: String,
    api_enabled: bool,
    api_port: u16,
    always_on_top: bool,
    transparent: bool,
}

impl StartupSettings {
    fn load(app: &AppHandle) -> Self {
        let store = app.store(SETTINGS_FILE).ok();
        let get = |key: &str| store.as_ref().and_then(|s| s.get(key));
        let flag = |key: &str, default: bool| get(key).and_then(|v| v.as_bool()).unwrap_or(default);
        Self {
            voicevox_url: get("voicevoxUrl")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| voicevox::DEFAULT_URL.into()),
            api_enabled: flag("apiEnabled", true),
            api_port: get("apiPort")
                .and_then(|v| v.as_u64())
                .and_then(|p| u16::try_from(p).ok())
                .unwrap_or(api::DEFAULT_PORT),
            always_on_top: flag("alwaysOnTop", false),
            transparent: flag("transparent", false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiStatus {
    enabled: bool,
    port: u16,
    listening: bool,
    error: Option<String>,
}

#[tauri::command]
async fn voicevox_speakers(client: State<'_, Arc<VoicevoxClient>>) -> Result<Vec<Speaker>, String> {
    client.speakers().await.map_err(|e| e.to_string())
}

/// Returns `[u32 LE json length][audio query JSON][wav]` as raw bytes.
#[tauri::command]
async fn voicevox_synthesize(
    text: String,
    speaker: u32,
    voice: Option<VoiceParams>,
    query: Option<serde_json::Value>,
    client: State<'_, Arc<VoicevoxClient>>,
) -> Result<tauri::ipc::Response, String> {
    let voice = voice.unwrap_or_default();
    voice.validate()?;
    let synthesis = client
        .synthesize(&text, speaker, &voice, query)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(synthesis.pack()))
}

/// A fresh `audio_query` for the editor to edit, with `voice` written over
/// the engine's defaults (an edited query doesn't get the character's voice
/// at play time any more).
#[tauri::command]
async fn voicevox_audio_query(
    text: String,
    speaker: u32,
    voice: Option<VoiceParams>,
    client: State<'_, Arc<VoicevoxClient>>,
) -> Result<serde_json::Value, String> {
    let voice = voice.unwrap_or_default();
    voice.validate()?;
    let mut query = client.audio_query(&text, speaker).await.map_err(|e| e.to_string())?;
    voice.apply(&mut query);
    Ok(query)
}

/// Recomputes mora pitch and/or length after an accent edit.
#[tauri::command]
async fn voicevox_update_moras(
    update: MoraUpdate,
    accent_phrases: serde_json::Value,
    speaker: u32,
    client: State<'_, Arc<VoicevoxClient>>,
) -> Result<serde_json::Value, String> {
    client
        .update_moras(update, &accent_phrases, speaker)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_voicevox_url(url: String, client: State<'_, Arc<VoicevoxClient>>) -> Result<(), String> {
    client.set_base_url(&url).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum LlmEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

/// Generations in flight by request id. Several can run at once (e.g. one
/// character preparing its turn while another speaks); each is cancelled on
/// its own, and Stop cancels them all.
#[derive(Default)]
struct LlmTasks(Arc<Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>>>);

/// Streams a chat completion into `on_event`.
#[tauri::command]
fn llm_chat(
    id: u32,
    url: String,
    model: String,
    messages: Vec<ChatMessage>,
    on_event: Channel<LlmEvent>,
    client: State<'_, Arc<LlmClient>>,
    tasks: State<'_, LlmTasks>,
) {
    let client = Arc::clone(&client);
    let running = Arc::clone(&tasks.0);
    // Held while spawning, so the task can't remove itself before it is inserted.
    let mut map = tasks.0.lock().unwrap();
    let handle = tauri::async_runtime::spawn(async move {
        let result = client
            .chat(&url, &model, &messages, |text| {
                let _ = on_event.send(LlmEvent::Delta { text });
            })
            .await;
        let _ = on_event.send(match result {
            Ok(()) => LlmEvent::Done,
            Err(e) => LlmEvent::Error { message: e.to_string() },
        });
        running.lock().unwrap().remove(&id);
    });
    if let Some(previous) = map.insert(id, handle) {
        previous.abort();
    }
}

#[tauri::command]
fn llm_cancel(id: u32, tasks: State<'_, LlmTasks>) {
    if let Some(handle) = tasks.0.lock().unwrap().remove(&id) {
        handle.abort();
    }
}

#[tauri::command]
fn llm_cancel_all(tasks: State<'_, LlmTasks>) {
    for (_, handle) in tasks.0.lock().unwrap().drain() {
        handle.abort();
    }
}

/// Scene files are the scene API's JSON; anything bigger is not one.
const MAX_SCENE_FILE_BYTES: u64 = api::MAX_BODY_BYTES as u64;
/// VOICEVOX projects to import.
const MAX_PROJECT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Opens the scene editor in its own window, so the stage window can stay
/// small and transparent. Focuses it if it is already open.
#[tauri::command]
fn open_editor(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("editor") {
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, "editor", WebviewUrl::App("editor.html".into()))
        .title("voxmate — Scene editor")
        .inner_size(760.0, 640.0)
        .min_inner_size(480.0, 320.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn scene_file_path(path: &str, extensions: &[&str]) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if extensions.contains(&ext) => Ok(path),
        _ => Err(format!("scene files must be .{}", extensions.join(" or ."))),
    }
}

/// Reads a scene file (or a VOICEVOX project to import) the user picked in the open dialog.
#[tauri::command]
fn read_scene_file(path: String) -> Result<String, String> {
    let path = scene_file_path(&path, &["json", "vvproj"])?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    // Projects carry edited queries and song tracks, so they get more room.
    let limit = if path.extension().is_some_and(|e| e == "vvproj") {
        MAX_PROJECT_FILE_BYTES
    } else {
        MAX_SCENE_FILE_BYTES
    };
    if size > limit {
        return Err(format!("{} is too large for a scene file", path.display()));
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes a scene file to the path the user picked in the save dialog.
#[tauri::command]
fn write_scene_file(path: String, contents: String) -> Result<(), String> {
    let path = scene_file_path(&path, &["json"])?;
    if contents.len() as u64 > MAX_SCENE_FILE_BYTES {
        return Err("the scene is too large to save".into());
    }
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// One line of a WAV export, resolved by the editor (speaker and voice).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportLine {
    text: String,
    speaker: u32,
    voice: Option<VoiceParams>,
    query: Option<serde_json::Value>,
}

/// Synthesizes `lines` in order and writes them to `path` as one WAV, with
/// `gap_seconds` of silence between lines.
#[tauri::command]
async fn export_wav(
    path: String,
    lines: Vec<ExportLine>,
    gap_seconds: f64,
    client: State<'_, Arc<VoicevoxClient>>,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path.extension().and_then(|e| e.to_str()) != Some("wav") {
        return Err("export to a .wav file".into());
    }
    let mut parts = Vec::with_capacity(lines.len());
    for (i, line) in lines.into_iter().enumerate() {
        let voice = line.voice.unwrap_or_default();
        voice.validate()?;
        let synthesis = client
            .synthesize(&line.text, line.speaker, &voice, line.query)
            .await
            .map_err(|e| format!("line {}: {e}", i + 1))?;
        parts.push(synthesis.wav);
    }
    let wav = wav::join(&parts, gap_seconds).map_err(|e| e.to_string())?;
    std::fs::write(path, wav).map_err(|e| e.to_string())
}

/// Lets the asset protocol serve a user-picked model and the files next to it
/// (textures, motions, physics...). The scope starts empty.
#[tauri::command]
fn allow_model_file(path: String, app: AppHandle) -> Result<(), String> {
    let path = PathBuf::from(path);
    let dir = path
        .parent()
        .filter(|_| path.is_file())
        .ok_or_else(|| format!("model file not found: {}", path.display()))?;
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn api_status(status: State<'_, Mutex<ApiStatus>>) -> ApiStatus {
    status.lock().unwrap().clone()
}

/// Set by the webview (`stage_ready`) once it listens for submissions.
#[derive(Default)]
struct StageReady(AtomicBool);

/// The webview finished starting and will now queue API lines.
#[tauri::command]
fn stage_ready(ready: State<'_, StageReady>) {
    ready.0.store(true, Ordering::SeqCst);
}

/// What the models on stage can do, by character id, for `GET /characters`.
#[tauri::command]
fn stage_capabilities(capabilities: HashMap<String, Capabilities>, tracker: State<'_, Arc<StageTracker>>) {
    tracker.set_capabilities(capabilities);
}

/// Lifecycle and log events from the webview, for `GET /scenes/{id}` and `GET /events`.
#[tauri::command]
fn stage_event(event: StageEvent, tracker: State<'_, Arc<StageTracker>>) {
    tracker.record(event);
}

/// The API's view of the app: submissions go to the webview as events, and
/// characters come from the saved settings, which the frontend keeps current.
struct AppBackend {
    app: AppHandle,
}

impl AppBackend {
    fn setting(&self, key: &str) -> Option<serde_json::Value> {
        self.app.store(SETTINGS_FILE).ok()?.get(key)
    }

    fn client(&self) -> Arc<VoicevoxClient> {
        self.app.state::<Arc<VoicevoxClient>>().inner().clone()
    }
}

impl api::Backend for AppBackend {
    fn ready(&self) -> bool {
        self.app.state::<StageReady>().0.load(Ordering::SeqCst)
    }

    fn submit(&self, submission: api::Submission) {
        if let Err(e) = self.app.emit(SUBMIT_EVENT, &submission) {
            eprintln!("failed to forward lines to the webview: {e}");
        }
    }

    fn cancel_scene(&self, id: &str) {
        if let Err(e) = self.app.emit(CANCEL_SCENE_EVENT, id) {
            eprintln!("failed to forward scene cancel to the webview: {e}");
        }
    }

    fn characters(&self) -> Vec<api::CharacterInfo> {
        let default = self.setting("defaultCharacter");
        api::character_infos(
            self.setting("characters").as_ref(),
            default.as_ref().and_then(|v| v.as_str()),
            &self.app.state::<Arc<StageTracker>>().capabilities(),
        )
    }

    fn speakers(&self) -> api::BoxFuture<Result<Vec<Speaker>, String>> {
        let client = self.client();
        Box::pin(async move { client.speakers().await.map_err(|e| e.to_string()) })
    }

    fn audio_query(&self, req: api::AudioQueryRequest) -> api::BoxFuture<Result<serde_json::Value, api::QueryError>> {
        let speaker = match req.speaker {
            Some(speaker) => Ok(speaker),
            None => {
                let default = self.setting("defaultCharacter");
                api::resolve_speaker(
                    self.setting("characters").as_ref(),
                    default.as_ref().and_then(|v| v.as_str()),
                    req.character.as_deref(),
                )
            }
        };
        let client = self.client();
        Box::pin(async move {
            client
                .audio_query(&req.text, speaker?)
                .await
                .map_err(|e| api::QueryError::Engine(e.to_string()))
        })
    }
}

fn start_api(app: &AppHandle, settings: &StartupSettings) -> ApiStatus {
    let mut status = ApiStatus {
        enabled: settings.api_enabled,
        port: settings.api_port,
        listening: false,
        error: None,
    };
    if !settings.api_enabled {
        return status;
    }
    match api::bind(settings.api_port) {
        Ok(listener) => {
            let state = api::ApiState {
                backend: Arc::new(AppBackend { app: app.clone() }),
                tracker: app.state::<Arc<StageTracker>>().inner().clone(),
            };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = api::serve(listener, state).await {
                    eprintln!("local API server stopped: {e}");
                }
            });
            status.listening = true;
        }
        Err(e) => {
            eprintln!("cannot bind local API to 127.0.0.1:{}: {e}", settings.api_port);
            status.error = Some(e.to_string());
        }
    }
    status
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = StartupSettings::load(&handle);

            let client = VoicevoxClient::new(&settings.voicevox_url).or_else(|e| {
                eprintln!("{e}; falling back to {}", voicevox::DEFAULT_URL);
                VoicevoxClient::new(voicevox::DEFAULT_URL)
            })?;
            let client = Arc::new(client);
            app.manage(client.clone());
            app.manage(Arc::new(LlmClient::new()?));
            app.manage(LlmTasks::default());
            app.manage(StageReady::default());
            app.manage(Arc::new(StageTracker::default()));
            app.manage(Mutex::new(start_api(&handle, &settings)));

            // Created here rather than in tauri.conf.json because transparency
            // can only be chosen at window creation time.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("voxmate")
                .inner_size(480.0, 720.0)
                .min_inner_size(320.0, 400.0)
                .transparent(settings.transparent)
                .always_on_top(settings.always_on_top)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            voicevox_speakers,
            voicevox_synthesize,
            voicevox_audio_query,
            voicevox_update_moras,
            set_voicevox_url,
            llm_chat,
            llm_cancel,
            llm_cancel_all,
            allow_model_file,
            api_status,
            stage_ready,
            stage_event,
            stage_capabilities,
            open_editor,
            read_scene_file,
            write_scene_file,
            export_wav,
        ])
        .run(tauri::generate_context!())
        .expect("error while running voxmate");
}
