# voxmate

A desktop "voice mate": a **VRM** or **Live2D** avatar that speaks text through
[VOICEVOX](https://voicevox.hiroshiba.jp/). Its mouth follows the phoneme timing
from VOICEVOX and the loudness of the audio. It runs on **Linux and macOS** (Tauri v2).

Text comes from the built-in text box or from a local HTTP API. Both go through
a pluggable `TextSource` interface, so an LLM source can be added later.

## Requirements

| What | Notes |
| --- | --- |
| VOICEVOX engine | Runs separately, by default on `http://127.0.0.1:50021` |
| Rust, Node.js 22+, pnpm | Provided by `nix develop` |
| Linux: WebKitGTK 4.1, libsoup 3, GTK 3, GStreamer | Provided by `nix develop` |
| macOS: Xcode Command Line Tools | `xcode-select --install` |
| Live2D only: Cubism Core | You download it yourself (see below) |

### Dev environment

**NixOS / Linux with Nix:**

```sh
git add flake.nix   # flakes only see files git tracks
nix develop         # creates flake.lock on first run
pnpm install
```

**Other Linux:** install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#linux)
(`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libssl-dev`, ...),
plus `gstreamer1.0-plugins-good` for audio, Rust (rustup) and pnpm.

**macOS:** install Xcode CLT, Rust (rustup), Node.js and pnpm. You can also use `nix develop`.

### VOICEVOX engine

Use either of these:

- the [VOICEVOX app](https://voicevox.hiroshiba.jp/), which starts the engine on port 50021, or
- Docker:
  ```sh
  docker run --rm -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest
  ```

To use a different engine URL, set it under **Settings → VOICEVOX URL**.
Check each character's terms of use before you publish any audio.

### Live2D Cubism Core (Live2D models only)

Cubism Core's license doesn't allow redistribution, so voxmate doesn't ship it.

1. Download the **Cubism SDK for Web** from <https://www.live2d.com/sdk/download/web/> and accept the license.
2. Copy `Core/live2dcubismcore.min.js` from the archive to `public/lib/live2dcubismcore.min.js`.

VRM models work without it. If a Live2D model is loaded and the file is missing, voxmate shows an error with these steps.

## Run

```sh
pnpm install
pnpm tauri dev      # development
pnpm tauri build    # release bundle (.deb/.AppImage/.rpm on Linux, .app/.dmg on macOS)
```

Then:

1. Click **Load model…** and pick a `.vrm` file (e.g. a [VRoid](https://vroid.com/) sample)
   or a Cubism 3/4 `.model3.json` (e.g. Hiyori/Haru from the Cubism SDK samples).
   voxmate remembers the model and loads it on the next start.
2. Pick a speaker, type some text, and press **Speak** (or Ctrl/⌘+Enter).

## Local API

The API listens on `127.0.0.1` only, default port `50080`. You can change the
port or turn the API off in Settings (takes effect after a restart).

```sh
curl -X POST localhost:50080/speak \
  -H 'content-type: application/json' \
  -d '{"text":"こんにちは"}'
# => 202 {"status":"queued"}

# Optional: pick a character (its id from Settings), or override the VOICEVOX
# style id for this utterance
curl -X POST localhost:50080/speak -H 'content-type: application/json' \
  -d '{"text":"やっほー","character":"default"}'
curl -X POST localhost:50080/speak -H 'content-type: application/json' \
  -d '{"text":"やっほー","speaker":1}'

curl localhost:50080/health
```

API, UI and LLM lines share one queue, so they never overlap. `/speak`
returns as soon as the text is queued.

The full spec is [`docs/openapi.json`](docs/openapi.json) (OpenAPI 3.1, generated
from `api.rs`), and the running app serves the same document at
`GET /openapi.json`. After changing the API, regenerate the committed copy with
`(cd src-tauri && UPDATE_OPENAPI=1 cargo test api::)`; `cargo test` fails while
it is stale.

The API rejects requests unless:

- the `Host` header is a loopback name, which blocks DNS rebinding, and
- the body is `application/json`, which a browser can't send cross-origin without a CORS preflight. voxmate never answers preflights, so web pages can't trigger speech.

## Settings

voxmate saves settings with `tauri-plugin-store` (`settings.json` in the app
data directory): characters, VOICEVOX URL, volume, and the API, LLM and window
options.

- **Characters** bundle a model, a VOICEVOX speaker, a persona (the LLM system
  prompt) and an optional LLM model. The one picked next to the speaker list is
  on stage: it speaks lines that name no character, and the speaker list, Load
  model… and the Character settings edit it. Its id is what `character` in
  `POST /speak` refers to. Settings from before characters existed (model,
  speaker, system prompt) become the `default` character on first start.
- **Always on top** takes effect immediately.
- **Transparent background** needs a restart. On macOS it uses the private
  API (`macOSPrivateApi`). On Linux it only works under a compositing window manager.

## Development

```sh
pnpm test                         # vitest: timeline, WAV, queue, lip sync
pnpm typecheck
(cd src-tauri && cargo test)      # VOICEVOX client (wiremock) + local API
(cd src-tauri && cargo fmt)       # rustfmt.toml: max_width = 120
```

### Layout

```
src/
  main.ts                  wiring: config → sources → StagePlayer → player/lipsync → avatar
  avatar/                  Avatar interface, VrmAvatar (three + three-vrm), Live2DAvatar (pixi + pixi-live2d-display)
  voice/                   VOICEVOX IPC, audio_query → mouth timeline, WAV decode, WebAudio player
  lipsync/LipSyncDriver.ts per frame: timeline vowel × normalized RMS → avatar.setMouth
  speech/                  TextSource interface, LocalApiSource
  stage/                   Line, StagePlayer (queue + lifecycle events), ConversationLog
  ui/controls.ts           control panel (also the "ui" TextSource)
  config.ts                persisted settings
  characters.ts            Character type, migration, id rules
src-tauri/src/
  voicevox.rs              reqwest client: /speakers, /audio_query, /synthesis
  api.rs                   axum server: POST /speak, GET /health, GET /openapi.json
  lib.rs                   commands, plugins, window creation, API startup
```

### Adding a text source (e.g. an LLM)

Implement `TextSource` (`src/speech/TextSource.ts`) and push sentences into the
sink as they stream in. Then add the source to the `sources` array in `main.ts`.
The queue synthesizes the next sentence while the current one plays.

### Troubleshooting

- **Blank or white window on Linux (NVIDIA / some Wayland setups):** start with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev`.
- **No sound on Linux:** WebKitGTK plays audio through GStreamer. Make sure
  `gst-plugins-base` and `gst-plugins-good` are installed (`nix develop` sets this up).
- **"cannot reach VOICEVOX engine":** make sure the engine is running, then check that `curl 127.0.0.1:50021/version` responds.

## License

MIT for voxmate itself. The Live2D Cubism Core, VOICEVOX, and voice libraries
and models each have their own licenses and terms.
