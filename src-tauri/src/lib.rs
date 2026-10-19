mod api;
mod llm;
mod stage;
mod voicevox;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use crate::llm::{ChatMessage, LlmClient};
use crate::stage::{StageEvent, StageTracker};
use crate::voicevox::{Speaker, VoiceParams, VoicevoxClient};

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

/// The generation in flight and its request id, so Stop (or a new question)
/// can abort it without touching a newer one.
#[derive(Default)]
struct LlmTask(Mutex<Option<(u32, tauri::async_runtime::JoinHandle<()>)>>);

/// Streams a chat completion into `on_event`. Replaces any running one.
#[tauri::command]
fn llm_chat(
    id: u32,
    url: String,
    model: String,
    messages: Vec<ChatMessage>,
    on_event: Channel<LlmEvent>,
    client: State<'_, Arc<LlmClient>>,
    task: State<'_, LlmTask>,
) {
    let client = Arc::clone(&client);
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
    });
    if let Some((_, previous)) = task.0.lock().unwrap().replace((id, handle)) {
        previous.abort();
    }
}

#[tauri::command]
fn llm_cancel(id: u32, task: State<'_, LlmTask>) {
    let mut current = task.0.lock().unwrap();
    if current.as_ref().is_some_and(|(running, _)| *running == id) {
        if let Some((_, handle)) = current.take() {
            handle.abort();
        }
    }
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
            app.manage(LlmTask::default());
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
            set_voicevox_url,
            llm_chat,
            llm_cancel,
            allow_model_file,
            api_status,
            stage_ready,
            stage_event,
        ])
        .run(tauri::generate_context!())
        .expect("error while running voxmate");
}
