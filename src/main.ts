import "./styles.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { Avatar } from "./avatar/Avatar";
import { assetUrl, createAvatar } from "./avatar/factory";
import { type Character, idError, newCharacter, resolveCharacter } from "./characters";
import { Config, type Settings } from "./config";
import { LipSyncDriver } from "./lipsync/LipSyncDriver";
import { OpenAiCompatibleProvider } from "./llm/LlmProvider";
import { LlmSource } from "./llm/LlmSource";
import { LocalApiSource } from "./speech/LocalApiSource";
import type { TextSource } from "./speech/TextSource";
import { ConversationLog } from "./stage/ConversationLog";
import { StagePlayer } from "./stage/StagePlayer";
import { Controls, type SimpleSetting } from "./ui/controls";
import { followTheme } from "./ui/theme";
import { AudioPlayer } from "./voice/player";
import { lineVoice } from "./voice/params";
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
  /** Bumped per model change, so a slow load can't replace a newer one. */
  let modelGeneration = 0;

  const characters = () => config.get("characters");
  /** The character on stage. */
  const onStage = () => resolveCharacter(characters(), config.get("defaultCharacter"));

  const stagePlayer = new StagePlayer<Prepared>({
    async prepare(line) {
      const character = resolveCharacter(characters(), config.get("defaultCharacter"), line.character);
      const voice = lineVoice(character.voice, line);
      const speaker = line.speaker ?? character.speaker;
      const { query, wav } = await synthesize(line.text, speaker, voice, line.audioQuery);
      return { buffer: await player.decode(wav), timeline: buildTimeline(query) };
    },
    async play(p) {
      if (!(await player.resume())) {
        throw new Error("audio is suspended. Click the window to enable sound, then send it again");
      }
      driver.setTimeline(p.timeline);
      try {
        await player.play(p.buffer);
      } finally {
        driver.clear();
      }
    },
    stop: () => player.stop(),
    defaultCharacter: () => config.get("defaultCharacter"),
  });
  const log = new ConversationLog();
  stagePlayer.subscribe((event) => {
    log.record(event);
    if (event.state === "failed") {
      controls.error(`Could not speak "${event.line.text.slice(0, 20)}": ${errorText(event.error)}`);
    }
    controls.setQueueState(stagePlayer.current?.text ?? null, stagePlayer.pending);
  });

  async function refreshSpeakers() {
    try {
      const speakers = await fetchSpeakers();
      controls.setSpeakers(speakers);
      controls.info(`Connected to VOICEVOX at ${config.get("voicevoxUrl")}`);
    } catch (e) {
      controls.error(`VOICEVOX: ${errorText(e)}`);
    }
  }

  /** Resolves false if a newer model change superseded this one; the avatar is then left alone. */
  async function loadModel(path: string): Promise<boolean> {
    const generation = ++modelGeneration;
    const file = path.split("/").pop();
    controls.info(`Loading ${file}…`);
    if (!avatar) controls.setModelState("loading", file);
    let next: Avatar | null = null;
    try {
      next = await createAvatar(path, stage);
      await invoke("allow_model_file", { path });
      await next.load(assetUrl(convertFileSrc(""), path));
    } catch (e) {
      next?.dispose();
      if (generation !== modelGeneration) return false;
      controls.setModelState(avatar ? "loaded" : "empty");
      throw e;
    }
    if (generation !== modelGeneration) {
      next.dispose();
      return false;
    }
    avatar?.dispose();
    avatar = next;
    controls.setModelState("loaded");
    controls.info(`Loaded ${file}`);
    return true;
  }

  function clearModel() {
    modelGeneration++;
    avatar?.dispose();
    avatar = null;
    controls.setModelState("empty");
  }

  /** Puts the on-stage character's model on stage. */
  async function showCharacter() {
    const { name, modelPath } = onStage();
    if (!modelPath) {
      clearModel();
      return;
    }
    try {
      await loadModel(modelPath);
    } catch (e) {
      // Don't leave the previous character's model standing in for this one.
      clearModel();
      controls.error(`Could not load the model of ${name}: ${errorText(e)}`);
    }
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
    const id = onStage().id;
    try {
      if (!(await loadModel(path))) return;
      await saveCharacters(characters().map((c) => (c.id === id ? { ...c, modelPath: path } : c)));
    } catch (e) {
      controls.error(errorText(e));
    }
  }

  async function saveCharacters(list: Character[], current = config.get("defaultCharacter")) {
    await config.set("characters", list);
    await config.set("defaultCharacter", current);
    controls.setCharacters(list, current);
  }

  async function selectCharacter(id: string) {
    if (id === config.get("defaultCharacter")) return;
    try {
      await saveCharacters(characters(), id);
    } catch (e) {
      controls.error(errorText(e));
      return;
    }
    await showCharacter();
  }

  async function addCharacter(duplicate: boolean) {
    const list = characters();
    const added = newCharacter(list, duplicate ? onStage() : undefined);
    try {
      await saveCharacters([...list, added], added.id);
    } catch (e) {
      controls.error(errorText(e));
      return;
    }
    controls.info(`Added ${added.name}`);
    // A duplicate keeps the same model, which is already on stage.
    if (!duplicate) await showCharacter();
  }

  async function removeCharacter() {
    const list = characters();
    const removed = onStage();
    if (list.length < 2) return;
    if (!window.confirm(`Remove ${removed.name}?`)) return;
    const rest = list.filter((c) => c !== removed);
    try {
      await saveCharacters(rest, rest[0].id);
    } catch (e) {
      controls.error(errorText(e));
      return;
    }
    controls.info(`Removed ${removed.name}`);
    await showCharacter();
  }

  async function editCharacter(patch: Partial<Character>) {
    const list = characters();
    const current = onStage();
    if (patch.id !== undefined && patch.id !== current.id) {
      const problem = idError(patch.id, list, current);
      if (problem) {
        controls.error(problem);
        controls.setCharacters(list, current.id);
        return;
      }
    }
    const edited = { ...current, ...patch };
    try {
      await saveCharacters(
        list.map((c) => (c === current ? edited : c)),
        edited.id,
      );
    } catch (e) {
      controls.error(errorText(e));
    }
  }

  async function change<K extends SimpleSetting>(key: K, value: Settings[K]) {
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

  const llmModel = () => onStage().llmModel || config.get("llmModel");

  const llm = new LlmSource(
    new OpenAiCompatibleProvider(() => ({ url: config.get("llmUrl"), model: llmModel() })),
    () => ({ systemPrompt: onStage().persona, history: config.get("llmHistory"), character: onStage().id }),
    (e) => controls.error(`LLM: ${errorText(e)}`),
  );

  function ask(text: string) {
    if (!llmModel()) {
      controls.error("Set an LLM model in Settings first.");
      return;
    }
    // A new question replaces whatever is still being said.
    stagePlayer.clear();
    controls.info(`Asking ${llmModel()}…`);
    void llm.ask(text);
  }

  const controls = new Controls(config.all(), {
    stop: () => {
      llm.cancel();
      stagePlayer.clear();
    },
    ask,
    loadModel: () => void pickModel(),
    refreshSpeakers: () => void refreshSpeakers(),
    change: (key, value) => void change(key, value),
    selectCharacter: (id) => void selectCharacter(id),
    addCharacter: (duplicate) => void addCharacter(duplicate),
    removeCharacter: () => void removeCharacter(),
    editCharacter: (patch) => void editCharacter(patch),
  });

  // Autoplay policies: resume audio on the first gesture. Playback also calls
  // resume() itself, which covers API requests arriving before any gesture.
  const unlock = () => void player.resume();
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  const sources: TextSource[] = [controls, new LocalApiSource(), llm];
  for (const source of sources) await source.start((line) => stagePlayer.enqueue(line));

  const api = await invoke<ApiStatus>("api_status");
  controls.setApiStatus(
    !api.enabled
      ? "Disabled."
      : api.listening
        ? `Listening on http://127.0.0.1:${api.port} — POST /speak {"text": "..."}`
        : `Failed to start on port ${api.port}: ${api.error ?? "unknown error"}`,
  );

  void refreshSpeakers();
  void showCharacter();

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
