# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

voxmate is a Tauri v2 desktop app (Linux + macOS). It shows a VRM or Live2D avatar that speaks text through a separately running VOICEVOX engine and lip-syncs to it. The frontend is TypeScript + Vite with no framework. The backend is Rust.

## Commands

Toolchain comes from `nix develop` (Rust, Node 22, pnpm, WebKitGTK/GStreamer libs and env vars).

```sh
pnpm install
pnpm tauri dev                     # run app (Vite on :1420 + Rust)
pnpm tauri build                   # release bundles
pnpm test                          # vitest (src/**/*.test.ts, node env)
pnpm vitest run src/voice/timeline.test.ts   # single test file
pnpm vitest run -t "name"          # single test by name
pnpm typecheck                     # tsc --noEmit
(cd src-tauri && cargo test)       # Rust: voicevox client (wiremock) + local API
(cd src-tauri && cargo test api::) # Rust tests in one module
(cd src-tauri && cargo fmt)        # rustfmt, max_width 120 (src-tauri/rustfmt.toml)
```

Running the app needs a VOICEVOX engine on `127.0.0.1:50021`. Blank window on Linux: `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Architecture

Data flow: `TextSource` → line → `StagePlayer` → `prepare` (synthesize + decode + build timeline) → `play` (AudioPlayer) while `LipSyncDriver.tick` drives `avatar.setMouth` each frame. `src/main.ts` wires all of this together.

- **All VOICEVOX HTTP goes through Rust** (`src-tauri/src/voicevox.rs`, reqwest), not the webview. `voicevox_synthesize` returns one binary IPC payload, `[u32 LE json length][audio_query JSON][wav]`. It is packed by `Synthesis::pack` (Rust) and unpacked by `unpack` (`src/voice/voicevox.ts`). Change both together.
- **Lip sync** combines two signals. `buildTimeline` (`src/voice/timeline.ts`) turns the `audio_query` mora/phoneme lengths into vowel segments; its ordering and timing rules mirror how the engine renders phonemes, so keep them in sync with VOICEVOX behavior. `LipSyncDriver` takes the vowel at `player.currentTime` (which accounts for output latency) and scales it by peak-normalized RMS from an AnalyserNode.
- **StagePlayer** (`src/stage/`) serializes the `Line`s of all sources so they never overlap. It prepares line N+1 while N plays. Each line reports `queued → preparing → speaking → done | interrupted | skipped | failed` to subscribers. A line dropped while it is being prepared is marked `cancelled`, so its late result is ignored. Scenes stay together, `"next"` inserts after the rest of the current scene, and `cancelScene`, `skip` and `clear` control the queue. `ConversationLog` records every line that was heard (done or interrupted), stage directions included. Deps are injected, so both are unit-tested without audio.
- **Text sources** implement `TextSource` (`src/speech/TextSource.ts`) and only push into a sink. To add one (e.g. an LLM), add it to the `sources` array in `main.ts`. The UI (`Controls`) is itself a source. `LocalApiSource` queues what the Local API (`src-tauri/src/api.rs`, axum) sends as `stage-submit` / `stage-cancel-scene` events, then calls `stage_ready` (until then the API answers 503). `main.ts` reports every line event and log entry back through `stage_event` into `StageTracker` (`src-tauri/src/stage.rs`), which serves `GET /scenes/{id}` and the `GET /events` SSE stream. Rust assigns line and scene ids so the API can return them at once.
- **Orchestrator** (`src/stage/Orchestrator.ts`) runs free talk: next speaker by name mention, else round-robin; generates turn N+1 once turn N's text is complete (passing N's unheard lines as `pending` context) but stays at most one turn ahead; a user line (`interject`) cancels the turn being generated; a line with a `sceneId` pauses it, drops its queued lines (`StagePlayer.skipQueued`) and resumes once the scene has played.
- **LLM**: `LlmSource` (`src/llm/`) is a `TextSource`. `ask()` logs the question in the `ConversationLog` and has the on-stage character's `LlmAgent` answer; `respond(characterId)` lets any character speak next. An agent builds its context from the shared log (`buildContext`: own lines → assistant, others → user with `Name: `, directions → `[Stage direction]` user notes) and yields each sentence (`SentenceSplitter`, `ThinkFilter`) as a line. `OpenAiCompatibleProvider` calls the `llm_chat` command; `src-tauri/src/llm.rs` streams `/v1/chat/completions` (SSE) back over a Tauri `Channel`. `LlmTasks` holds several generations by request id; `llm_cancel` aborts one, `llm_cancel_all` all. Stop cancels every generation as well as clearing the queue. `LlmEvent` (`lib.rs`) is mirrored in `LlmProvider.ts`.
- **Avatars** sit behind the `Avatar` interface (`src/avatar/Avatar.ts`). `factory.ts` picks the implementation by extension (`.vrm` → three-vrm, `.model3.json` → pixi-live2d-display) and lazy-imports it. Models load through the asset protocol. Its scope starts empty (`tauri.conf.json`), and the `allow_model_file` command allows the model's directory at runtime. `assetUrl` encodes paths per segment so relative texture/motion references still resolve.
- **Live2D Cubism Core** is not redistributable. It is loaded at runtime from `public/lib/live2dcubismcore.min.js` (gitignored, user-supplied). Never add it to the repo or bundle it.

## Cross-file invariants

- **Settings keys**: `src/config.ts` owns writing `settings.json` (tauri-plugin-store). `StartupSettings::load` in `src-tauri/src/lib.rs` reads `voicevoxUrl`, `apiEnabled`, `apiPort`, `alwaysOnTop` and `transparent` before the webview exists. Rename keys in both places.
- `LineRequest` and `Submission` (`api.rs`) and `StageEvent` (`stage.rs`) are mirrored in `LocalApiSource.ts`. `LineState` mirrors `LineState` in `src/stage/Line.ts`. `VoiceParams` (`voicevox.rs`) is mirrored in `src/voice/params.ts`, ranges included. The character id rule (`is_character_id`) mirrors `idError` in `src/characters.ts`. `docs/openapi.json` is generated from `api.rs` (utoipa); after changing the API run `(cd src-tauri && UPDATE_OPENAPI=1 cargo test api::)` or `cargo test` fails.
- The main window is built in `lib.rs` setup, not in `tauri.conf.json` (`windows: []`), because transparency can only be set at creation. New window permissions go in `src-tauri/capabilities/default.json` (window label `main`). New Rust commands must be registered in `generate_handler!`.
- Local API security model (keep it when changing `api.rs`): bind 127.0.0.1 only, reject non-loopback `Host` (DNS rebinding), require `application/json`, never answer CORS preflights. Text is capped at `MAX_TEXT_CHARS`.
