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
# => 202 {"status":"queued","lineId":"…"}

# Optional: pick a character (its id from Settings), or override the VOICEVOX
# style id for this utterance
curl -X POST localhost:50080/speak -H 'content-type: application/json' \
  -d '{"text":"やっほー","character":"default"}'
curl -X POST localhost:50080/speak -H 'content-type: application/json' \
  -d '{"text":"やっほー","speaker":1}'

# Optional: voice parameters (speed, pitch, intonation, volume,
# prePhonemeLength, postPhonemeLength, pauseLengthScale). They override the
# character's defaults from Settings; out-of-range values get a 400.
curl -X POST localhost:50080/speak -H 'content-type: application/json' \
  -d '{"text":"ゆっくり話すのだ","voice":{"speed":0.8,"pitch":0.05}}'

# Editor-level control: fetch the engine's audio_query, edit accents, mora
# pitch/length or pauses, then speak it. "voice" still overrides its values.
# A query belongs to its speaker; with another speaker it sounds off.
curl -X POST localhost:50080/audio_query -H 'content-type: application/json' \
  -d '{"text":"こんにちは","character":"default"}' > query.json
curl -X POST localhost:50080/speak -H 'content-type: application/json' \
  -d "{\"text\":\"こんにちは\",\"audioQuery\":$(cat query.json)}"

# Scenes: several lines, possibly by different characters, kept together.
# "placement":"next" puts them right after the current line instead of last.
curl -X POST localhost:50080/scenes -H 'content-type: application/json' \
  -d '{"lines":[{"character":"zunda","text":"こんにちは"},
                {"character":"metan","text":"こんにちは、ずんだもん"},
                {"text":"(話題は夕食に移る)","direction":true}]}'
# => 202 {"id":"…","lineIds":["…","…","…"]}
curl localhost:50080/scenes/<id>              # per-line state
curl -X DELETE localhost:50080/scenes/<id>    # cancel the rest

# Acting: an emotion held for the line, and cues at "start", "end", seconds or
# an accent phrase ({"phrase": n}). Portable names (neutral happy sad angry
# surprised relaxed; nod shake tilt) map to each model via "Model names" in the
# Character settings; a model's own names (GET /characters) work too.
curl -X POST localhost:50080/speak -H 'content-type: application/json' \
  -d '{"text":"えっ、本当なのだ？","emotion":"surprised",
       "cues":[{"at":{"phrase":1},"gesture":"tilt"},{"at":"end","lookAt":"metan"}]}'

# Follow playback (Server-Sent Events): "line" events (queued, preparing,
# speaking, done, interrupted, skipped, failed) and "log" entries for every
# line, whoever produced it.
curl -N localhost:50080/events

curl localhost:50080/characters   # ids, names, speakers, default voices
curl localhost:50080/speakers     # VOICEVOX speakers and style ids

curl localhost:50080/health
```

API, UI and LLM lines share one queue, so they never overlap. `/speak` and
`/scenes` return as soon as the lines are queued, and answer 503 while the app
is still starting. A scene has at most 200 lines, and request bodies are
limited to 1 MiB. A stage direction is never spoken, only logged.

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
  prompt), an optional LLM model and default voice parameters (empty = engine
  default). The one picked next to the speaker list is the default: it speaks
  lines that name no character, picking it brings it on stage, and the speaker
  list, Load model… and the Character settings edit it. Several characters can
  be on stage at once, side by side (VRM and Live2D mixed); **On stage** in the
  Character settings takes one off. Only the speaker's mouth moves. The others
  turn toward the speaker and sometimes nod when a line ends. LLM replies can
  act too: characters may write tags like `[happy]` or `[nod]`, which are acted
  out instead of spoken. Each
  character on stage is a WebGL canvas, so keep it to a handful. Its id is what `character` in
  `POST /speak` refers to. Settings from before characters existed (model,
  speaker, system prompt) become the `default` character on first start.
- **LLM mode** (next to the character picker): **Reply** lets the character
  named in the question answer (else the one on stage); **Free talk** lets the
  characters talk with each other (optionally on a topic) until the turn or
  time limit in Settings, Stop, or a turn with nothing to say. Asking during
  free talk joins the conversation: the next turn answers you. A script from
  the API pauses free talk: the current line finishes, then the scene plays,
  then the conversation resumes with it in the log. **LLM off** disables Ask.
- **Ask** sends the question to the character on stage's LLM agent. Every
  character answers from the shared conversation log: everything said on
  stage (by any character, a script or the user) in the last **History**
  lines, so characters can refer to each other's lines. Its persona is the
  system prompt. With llama-swap, characters on different models swap models
  on every turn unless the models are kept loaded together (a llama-swap
  group); one model with different personas avoids that.
- **Editor…** opens the scene editor in its own window: one line per row with
  its character, text, voice (the character's defaults show as placeholders),
  expression, gesture and stage-direction flag. Play a line, play from a line
  or play all; the line being spoken is highlighted. Scenes are saved as the
  `POST /scenes` JSON, so a saved file can be posted from a script as is.
  **Export WAV…** (or ⤓ on a line) synthesizes the scene into one WAV file.
  **Open…** also imports the talk track of a VOICEVOX project (`.vvproj`):
  each item becomes a line with its edited query, and its voice maps to the
  character with that speaker (or stays as the line's `speaker`).
- **Always on top** takes effect immediately.
- **Transparent background** needs a restart. On macOS it uses the private
  API (`macOSPrivateApi`). On Linux it only works under a compositor (any
  Wayland session, or X11 with a compositing window manager); the window
  decorations stay opaque. See Troubleshooting if it still isn't see-through.

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
  api.rs                   axum server: /speak, /scenes, /events (SSE), /characters, /speakers, /audio_query, /health, /openapi.json
  stage.rs                 scene status and event fan-out for the API
  lib.rs                   commands, plugins, window creation, API startup
```

### Adding a text source (e.g. an LLM)

Implement `TextSource` (`src/speech/TextSource.ts`) and push sentences into the
sink as they stream in. Then add the source to the `sources` array in `main.ts`.
The queue synthesizes the next sentence while the current one plays.

### Troubleshooting

- **Blank or white window on Linux (NVIDIA / some Wayland setups):** start with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev`.
- **Transparent background is not see-through on Linux:** check that the
  setting was saved before the last start. If the window is black or opaque,
  try starting with `WEBKIT_DISABLE_COMPOSITING_MODE=1`, or without
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` if your GPU works without it. If it looks
  frosted or tinted, it is the compositor: on Hyprland, check the window rules
  (`opacity`, `noblur`) for `voxmate` in `hyprctl clients`.
- **No sound on Linux:** WebKitGTK plays audio through GStreamer. Make sure
  `gst-plugins-base` and `gst-plugins-good` are installed (`nix develop` sets this up).
- **"cannot reach VOICEVOX engine":** make sure the engine is running, then check that `curl 127.0.0.1:50021/version` responds.

## License

MIT for voxmate itself. The Live2D Cubism Core, VOICEVOX, and voice libraries
and models each have their own licenses and terms.
