mod api;
mod voicevox;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use crate::api::SpeakRequest;
use crate::voicevox::{Speaker, VoicevoxClient};

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
async fn voicevox_speakers(client: State<'_, VoicevoxClient>) -> Result<Vec<Speaker>, String> {
    client.speakers().await.map_err(|e| e.to_string())
}

/// Returns `[u32 LE json length][audio query JSON][wav]` as raw bytes.
#[tauri::command]
async fn voicevox_synthesize(
    text: String,
    speaker: u32,
    client: State<'_, VoicevoxClient>,
) -> Result<tauri::ipc::Response, String> {
    let synthesis = client
        .synthesize(&text, speaker)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(synthesis.pack()))
}

#[tauri::command]
fn set_voicevox_url(url: String, client: State<'_, VoicevoxClient>) -> Result<(), String> {
    client.set_base_url(&url).map_err(|e| e.to_string())
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
            let sink: api::SpeakSink = Arc::new(move |req: SpeakRequest| {
                if let Err(e) = handle.emit(SPEAK_EVENT, &req) {
                    eprintln!("failed to forward speak request: {e}");
                }
            });
            tauri::async_runtime::spawn(async move {
                if let Err(e) = api::serve(listener, sink).await {
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
            app.manage(client);
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
            allow_model_file,
            api_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running voxmate");
}
