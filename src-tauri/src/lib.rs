mod api;
mod llm;
mod voicevox;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use crate::api::SpeakRequest;
use crate::llm::{ChatMessage, LlmClient};
use crate::voicevox::{Speaker, VoiceParams, VoicevoxClient};

/// Shared with the frontend (`src/config.ts`), which owns writing it.
const SETTINGS_FILE: &str = "settings.json";
const SPEAK_EVENT: &str = "speak-request";

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

/// Answers `POST /audio_query`: resolves `character` from the saved settings,
/// which the frontend keeps up to date, then asks the engine.
fn audio_query_source(app: &AppHandle) -> api::AudioQuerySource {
    let app = app.clone();
    Arc::new(move |req: api::AudioQueryRequest| {
        let app = app.clone();
        Box::pin(async move {
            let speaker = match req.speaker {
                Some(speaker) => speaker,
                None => {
                    let store = app.store(SETTINGS_FILE).ok();
                    let get = |key: &str| store.as_ref().and_then(|s| s.get(key));
                    let default = get("defaultCharacter");
                    api::resolve_speaker(
                        get("characters").as_ref(),
                        default.as_ref().and_then(|v| v.as_str()),
                        req.character.as_deref(),
                    )?
                }
            };
            let client = app.state::<Arc<VoicevoxClient>>().inner().clone();
            client
                .audio_query(&req.text, speaker)
                .await
                .map_err(|e| api::QueryError::Engine(e.to_string()))
        })
    })
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
            let handle = app.clone();
            let speak: api::SpeakSink = Arc::new(move |req: SpeakRequest| {
                if let Err(e) = handle.emit(SPEAK_EVENT, &req) {
                    eprintln!("failed to forward speak request: {e}");
                }
            });
            let state = api::ApiState {
                speak,
                audio_query: audio_query_source(app),
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running voxmate");
}
