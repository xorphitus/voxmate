import "./styles.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { Avatar } from "./avatar/Avatar";
import { assetUrl, createAvatar } from "./avatar/factory";
import { Config, type Settings } from "./config";
import { LipSyncDriver } from "./lipsync/LipSyncDriver";
import { LocalApiSource } from "./speech/LocalApiSource";
import { SpeechQueue } from "./speech/SpeechQueue";
import type { TextSource } from "./speech/TextSource";
import { Controls } from "./ui/controls";
import { followTheme } from "./ui/theme";
import { AudioPlayer } from "./voice/player";
import { buildTimeline, type Segment } from "./voice/timeline";
import { fetchSpeakers, setVoicevoxUrl, synthesize } from "./voice/voicevox";

interface Prepared {
  buffer: AudioBuffer;
  timeline: Segment[];
}

interface ApiStatus {
  enabled: boolean;
  port: number;
  listening: boolean;
  error: string | null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function main() {
  const config = await Config.open();
  const applyTheme = await followTheme(() => config.get("theme"));
  const stage = document.getElementById("stage")!;
  const player = new AudioPlayer();
  player.setVolume(config.get("volume"));
  const driver = new LipSyncDriver(player);
  let avatar: Avatar | null = null;

  const queue = new SpeechQueue<Prepared>({
    async prepare(u) {
      const { query, wav } = await synthesize(u.text, u.speaker ?? config.get("speaker"));
      return { buffer: await player.decode(wav), timeline: buildTimeline(query) };
    },
    async play(p) {
      await player.resume();
      driver.setTimeline(p.timeline);
      try {
        await player.play(p.buffer);
      } finally {
        driver.clear();
      }
    },
    stop: () => player.stop(),
    onError: (e, u) => controls.error(`Could not speak "${u.text.slice(0, 20)}": ${errorText(e)}`),
    onStateChange: ({ speaking, pending }) => controls.setQueueState(speaking?.text ?? null, pending),
  });

  async function refreshSpeakers() {
    try {
      const speakers = await fetchSpeakers();
      controls.setSpeakers(speakers, config.get("speaker"));
      controls.info(`Connected to VOICEVOX at ${config.get("voicevoxUrl")}`);
    } catch (e) {
      controls.error(`VOICEVOX: ${errorText(e)}`);
    }
  }

  async function loadModel(path: string) {
    controls.info(`Loading ${path.split("/").pop()}…`);
    const next = await createAvatar(path, stage);
    try {
      await invoke("allow_model_file", { path });
      await next.load(assetUrl(convertFileSrc(""), path));
    } catch (e) {
      next.dispose();
      throw e;
    }
    avatar?.dispose();
    avatar = next;
    controls.setModelLoaded(true);
    controls.info(`Loaded ${path.split("/").pop()}`);
  }

  async function pickModel() {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Avatar model", extensions: ["vrm", "json"] },
        { name: "VRM", extensions: ["vrm"] },
        { name: "Live2D (Cubism 3+)", extensions: ["json"] },
      ],
    });
    if (!path) return;
    try {
      await loadModel(path);
      await config.set("modelPath", path);
    } catch (e) {
      controls.error(errorText(e));
    }
  }

  async function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    try {
      switch (key) {
        case "voicevoxUrl":
          await setVoicevoxUrl(value as string);
          await config.set(key, value);
          await refreshSpeakers();
          return;
        case "volume":
          player.setVolume(value as number);
          break;
        case "alwaysOnTop":
          await getCurrentWindow().setAlwaysOnTop(value as boolean);
          break;
        case "theme":
          await config.set(key, value);
          applyTheme();
          return;
        case "transparent":
        case "apiEnabled":
        case "apiPort":
          controls.info("Saved. Restart voxmate to apply.");
          break;
      }
      await config.set(key, value);
    } catch (e) {
      controls.error(errorText(e));
    }
  }

  const controls = new Controls(config.all(), {
    stop: () => queue.clear(),
    loadModel: () => void pickModel(),
    refreshSpeakers: () => void refreshSpeakers(),
    change: (key, value) => void change(key, value),
  });

  // Autoplay policies: resume audio on the first gesture. Playback also calls
  // resume() itself, which covers API requests arriving before any gesture.
  const unlock = () => void player.resume();
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  const sources: TextSource[] = [controls, new LocalApiSource()];
  for (const source of sources) await source.start((u) => queue.enqueue(u));

  const api = await invoke<ApiStatus>("api_status");
  controls.setApiStatus(
    !api.enabled
      ? "Disabled."
      : api.listening
        ? `Listening on http://127.0.0.1:${api.port} — POST /speak {"text": "..."}`
        : `Failed to start on port ${api.port}: ${api.error ?? "unknown error"}`,
  );

  void refreshSpeakers();
  const modelPath = config.get("modelPath");
  if (modelPath) {
    loadModel(modelPath).catch((e) => controls.error(`Could not load saved model: ${errorText(e)}`));
  }

  new ResizeObserver(() => avatar?.resize()).observe(stage);

  let last = performance.now();
  const frame = (now: number) => {
    // Clamp so a backgrounded window doesn't produce one huge step.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    driver.tick(dt, avatar);
    avatar?.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `Startup failed: ${errorText(e)}`;
    status.classList.add("error");
  }
});
