import "./styles.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { assetUrl, createAvatar } from "./avatar/factory";
import { domSlots, type MemberState, StageView } from "./avatar/StageView";
import { type Character, idError, newCharacter, resolveCharacter } from "./characters";
import { Config, type Settings } from "./config";
import { LlmAgent } from "./llm/LlmAgent";
import { cancelAllGenerations, OpenAiCompatibleProvider } from "./llm/LlmProvider";
import { LlmSource } from "./llm/LlmSource";
import { LocalApiSource, reportCapabilities, reportLineEvent, reportLogEntry } from "./speech/LocalApiSource";
import { PORTABLE_EXPRESSIONS, PORTABLE_GESTURES, scheduleCues } from "./avatar/cues";
import type { TextSource } from "./speech/TextSource";
import { ConversationLog } from "./stage/ConversationLog";
import { addressed, Orchestrator } from "./stage/Orchestrator";
import { StagePlayer } from "./stage/StagePlayer";
import type { Scene } from "./stage/Line";
import { EDITOR_PLAY, EDITOR_STOP, type EditorPlay, type EditorStop, STAGE_LINE, type StageLine } from "./editor/bridge";
import { Controls, type SimpleSetting } from "./ui/controls";
import { followTheme } from "./ui/theme";
import { AudioPlayer } from "./voice/player";
import { lineVoice } from "./voice/params";
import { buildTimeline, phraseStarts, type Segment } from "./voice/timeline";
import { fetchSpeakers, setVoicevoxUrl, synthesize } from "./voice/voicevox";

interface Prepared {
  buffer: AudioBuffer;
  timeline: Segment[];
  /** Accent phrase start times, for cues. */
  phrases: number[];
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

  const characters = () => config.get("characters");
  /** The default character: it speaks lines that name none, and the panel edits it. */
  const onStage = () => resolveCharacter(characters(), config.get("defaultCharacter"));

  const stageView = new StageView({
    clock: player,
    createSlot: domSlots(stage),
    async loadAvatar(path, container) {
      const avatar = await createAvatar(path, container);
      try {
        await invoke("allow_model_file", { path });
        await avatar.load(assetUrl(convertFileSrc(""), path));
      } catch (e) {
        avatar.dispose();
        throw e;
      }
      return avatar;
    },
    onChange: (members) => showStageState(members),
  });

  /** Load errors already shown, so a later stage change doesn't repeat them. */
  const shownErrors = new Set<string>();

  /** The big placeholder (with its Load button) is for a stage of one without a model. */
  function showStageState(members: MemberState[]) {
    reportCapabilities(Object.fromEntries(members.flatMap((m) => (m.capabilities ? [[m.id, m.capabilities]] : []))));
    const loaded = members.some((m) => m.status === "loaded");
    if (loaded || members.length > 1) controls.setModelState("loaded");
    else if (members[0]?.status === "loading") controls.setModelState("loading", members[0].name);
    else controls.setModelState("empty");
    for (const m of members) {
      const key = `${m.id}:${m.error}`;
      if (m.status !== "error" || shownErrors.has(key)) continue;
      shownErrors.add(key);
      controls.error(`Could not load the model of ${m.name}: ${m.error}`);
    }
  }

  /** Shows the characters in the `stage` setting. */
  function syncStage() {
    const byId = new Map(characters().map((c) => [c.id, c]));
    const members = config
      .get("stage")
      .flatMap((id) => {
        const c = byId.get(id);
        return c ? [{ id, name: c.name, modelPath: c.modelPath, names: c.names }] : [];
      });
    return stageView.sync(members);
  }

  const stagePlayer = new StagePlayer<Prepared>({
    async prepare(line) {
      const character = resolveCharacter(characters(), config.get("defaultCharacter"), line.character);
      const voice = lineVoice(character.voice, line);
      const speaker = line.speaker ?? character.speaker;
      const { query, wav } = await synthesize(line.text, speaker, voice, line.audioQuery);
      return { buffer: await player.decode(wav), timeline: buildTimeline(query), phrases: phraseStarts(query) };
    },
    async play(p, line) {
      if (!(await player.resume())) {
        throw new Error("audio is suspended. Click the window to enable sound, then send it again");
      }
      // Only the speaker's mouth moves; the others listen.
      stageView.speak(line.character, p.timeline, scheduleCues(line.cues, line.emotion, p.phrases));
      try {
        await player.play(p.buffer);
      } finally {
        stageView.silence();
      }
    },
    stop: () => player.stop(),
    defaultCharacter: () => config.get("defaultCharacter"),
  });
  const log = new ConversationLog();
  log.subscribe(reportLogEntry);
  stagePlayer.subscribe((event) => {
    reportLineEvent(event);
    const { line, state, error } = event;
    const forEditor: StageLine = {
      lineId: line.id,
      state,
      ...(line.sceneId && { sceneId: line.sceneId }),
      ...(error !== undefined && { error: errorText(error) }),
    };
    void emit(STAGE_LINE, forEditor);
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
      await saveCharacters(characters().map((c) => (c.id === id ? { ...c, modelPath: path } : c)));
    } catch (e) {
      controls.error(errorText(e));
      return;
    }
    controls.info(`Loading ${path.split("/").pop()}…`);
    await syncStage();
    if (stageView.state.find((m) => m.id === id)?.status === "loaded") controls.info(`Loaded ${path.split("/").pop()}`);
  }

  /**
   * Saves the characters, the default one and who is on stage (the default
   * is always on stage), then updates the panel and the stage.
   */
  async function saveCharacters(
    list: Character[],
    current = config.get("defaultCharacter"),
    stageIds = config.get("stage"),
  ) {
    const known = new Set(list.map((c) => c.id));
    const members = stageIds.filter((id) => known.has(id));
    if (!members.includes(current)) members.push(current);
    await config.set("characters", list);
    await config.set("defaultCharacter", current);
    await config.set("stage", members);
    controls.setCharacters(list, current, members);
    void syncStage();
  }

  async function selectCharacter(id: string) {
    if (id === config.get("defaultCharacter")) return;
    try {
      await saveCharacters(characters(), id);
    } catch (e) {
      controls.error(errorText(e));
    }
  }

  async function setOnStage(on: boolean) {
    const id = onStage().id;
    const members = config.get("stage");
    try {
      if (on) {
        await saveCharacters(characters(), id, [...members, id]);
      } else {
        const rest = members.filter((m) => m !== id);
        // The default character must stay on stage, so another member takes over.
        if (rest.length) await saveCharacters(characters(), rest[0], rest);
        else controls.setCharacters(characters(), id, members);
      }
    } catch (e) {
      controls.error(errorText(e));
    }
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
  }

  async function removeCharacter() {
    const list = characters();
    const removed = onStage();
    if (list.length < 2) return;
    if (!window.confirm(`Remove ${removed.name}?`)) return;
    const rest = list.filter((c) => c !== removed);
    const members = config.get("stage").filter((id) => id !== removed.id);
    try {
      await saveCharacters(rest, members[0] ?? rest[0].id, members);
    } catch (e) {
      controls.error(errorText(e));
      return;
    }
    controls.info(`Removed ${removed.name}`);
  }

  async function editCharacter(patch: Partial<Character>) {
    const list = characters();
    const current = onStage();
    if (patch.id !== undefined && patch.id !== current.id) {
      const problem = idError(patch.id, list, current);
      if (problem) {
        controls.error(problem);
        controls.setCharacters(list, current.id, config.get("stage"));
        return;
      }
    }
    const edited = { ...current, ...patch };
    // A renamed id keeps its place on stage.
    const members = config.get("stage").map((id) => (id === current.id ? edited.id : id));
    try {
      await saveCharacters(
        list.map((c) => (c === current ? edited : c)),
        edited.id,
        members,
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
        case "llmMode":
          if (value !== "free") orchestrator.stop();
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

  /** Each character answers with its own persona and, if set, its own model. */
  function agent(characterId?: string) {
    const character = resolveCharacter(characters(), config.get("defaultCharacter"), characterId);
    const model = character.llmModel || config.get("llmModel");
    // Portable names always work; the model's own names once it is loaded on stage.
    const own = stageView.state.find((m) => m.id === character.id)?.capabilities;
    const cues = {
      expressions: [...new Set([...PORTABLE_EXPRESSIONS, ...(own?.expressions ?? [])])],
      gestures: [...new Set([...PORTABLE_GESTURES, ...(own?.gestures ?? [])])],
    };
    return new LlmAgent({
      character: { ...character, cues },
      provider: new OpenAiCompatibleProvider(() => ({ url: config.get("llmUrl"), model })),
      nameOf: (id) => characters().find((c) => c.id === id)?.name ?? id,
      history: config.get("llmHistory"),
      source: "llm",
    });
  }

  const llm = new LlmSource({ agent, log, onError: (e) => controls.error(`LLM: ${errorText(e)}`) });

  /** The characters on stage take part in free talk. */
  const participants = () =>
    config.get("stage").flatMap((id) => characters().filter((c) => c.id === id).map(({ name }) => ({ id, name })));

  const orchestrator = new Orchestrator({
    participants,
    log: () => log.entries(),
    respond: (id, signal, pending) => llm.respond(id, { signal, pending }),
    onLineEvent: (listener) => stagePlayer.subscribe(listener),
    skipQueued: (match) => stagePlayer.skipQueued(match),
    direct: (text) => {
      const line = { id: crypto.randomUUID(), character: "", text, source: "ui", direction: true };
      log.record({ line, state: "done" });
    },
    onStateChange: (state) => controls.setFreeState(state),
  });

  function startFree(topic = "") {
    orchestrator.start({
      maxTurns: config.get("freeMaxTurns"),
      maxMinutes: config.get("freeMaxMinutes"),
      topic,
    });
  }

  function ask(text: string) {
    if (!llmModel()) {
      controls.error("Set an LLM model in Settings first.");
      return;
    }
    // A new question replaces whatever is still being said.
    stagePlayer.clear();
    if (config.get("llmMode") === "free") {
      // The user joins the conversation; the next turn answers them.
      log.recordUser(text, "ui");
      if (orchestrator.current.running) orchestrator.interject();
      else startFree();
      return;
    }
    const speaker = addressed(text, participants()) ?? onStage().id;
    controls.info(`Asking ${characters().find((c) => c.id === speaker)?.name ?? speaker}…`);
    void llm.ask(text, speaker);
  }

  function toggleFree(topic: string) {
    if (orchestrator.current.running) {
      orchestrator.stop();
    } else if (!llmModel()) {
      controls.error("Set an LLM model in Settings first.");
    } else if (participants().length < 2) {
      controls.error("Free talk needs at least two characters on stage. Pick another one to bring it on stage.");
    } else {
      startFree(topic);
    }
  }

  const controls = new Controls(config.all(), {
    stop: () => {
      orchestrator.stop();
      llm.cancel();
      cancelAllGenerations();
      stagePlayer.clear();
    },
    ask,
    toggleFree,
    openEditor: () => void invoke("open_editor").catch((e) => controls.error(errorText(e))),
    loadModel: () => void pickModel(),
    refreshSpeakers: () => void refreshSpeakers(),
    change: (key, value) => void change(key, value),
    selectCharacter: (id) => void selectCharacter(id),
    addCharacter: (duplicate) => void addCharacter(duplicate),
    removeCharacter: () => void removeCharacter(),
    setOnStage: (on) => void setOnStage(on),
    editCharacter: (patch) => void editCharacter(patch),
  });

  // Autoplay policies: resume audio on the first gesture. Playback also calls
  // resume() itself, which covers API requests arriving before any gesture.
  const unlock = () => void player.resume();
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  const sources: TextSource[] = [controls, new LocalApiSource(stagePlayer), llm];
  for (const source of sources) await source.start((line) => stagePlayer.enqueue(line));

  // The scene editor window plays through this stage.
  await listen<EditorPlay>(EDITOR_PLAY, ({ payload }) => {
    const lines = payload.lines as unknown as Scene["lines"];
    stagePlayer.enqueueScene({ id: payload.sceneId, source: "editor", lines }, "end");
  });
  await listen<EditorStop>(EDITOR_STOP, ({ payload }) => stagePlayer.cancelScene(payload.sceneId));

  const api = await invoke<ApiStatus>("api_status");
  controls.setApiStatus(
    !api.enabled
      ? "Disabled."
      : api.listening
        ? `Listening on http://127.0.0.1:${api.port} — POST /speak {"text": "..."}`
        : `Failed to start on port ${api.port}: ${api.error ?? "unknown error"}`,
  );

  void refreshSpeakers();
  void syncStage();

  new ResizeObserver(() => stageView.resize()).observe(stage);

  let last = performance.now();
  const frame = (now: number) => {
    // Clamp so a backgrounded window doesn't produce one huge step.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    stageView.tick(dt);
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
