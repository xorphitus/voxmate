import "../styles.css";
import "./editor.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { PORTABLE_EXPRESSIONS, PORTABLE_GESTURES } from "../avatar/cues";
import { type Character, sanitizeCharacters } from "../characters";
import { SETTINGS_FILE } from "../config";
import { followTheme, type ThemePreference } from "../ui/theme";
import { inRange, VOICE_RANGES, type VoiceField } from "../voice/params";
import { EDITOR_PLAY, EDITOR_STOP, type EditorPlay, STAGE_LINE, type StageLine } from "./bridge";
import {
  blankLine,
  type EditorLine,
  fromSceneFile,
  insertLine,
  moveLine,
  removeLine,
  startGesture,
  toRequest,
  toSceneFile,
  withStartGesture,
} from "./scene";

/** The voice fields shown per line; the rest are kept from loaded files. */
const VOICE_EDITED: VoiceField[] = ["speed", "pitch", "intonation", "volume"];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from editor.html`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

async function main() {
  // Read-only: the stage window owns writing settings.
  const store = await load(SETTINGS_FILE, { defaults: {}, autoSave: false });
  let characters = sanitizeCharacters(await store.get("characters"));
  let defaultCharacter = (await store.get<string>("defaultCharacter")) ?? characters[0]?.id ?? "default";
  let theme = (await store.get<ThemePreference>("theme")) ?? "system";
  const applyTheme = await followTheme(() => theme);

  let lines: EditorLine[] = [blankLine(defaultCharacter)];
  /** The scene playing now, and which editor line each of its line ids is. */
  let playing: { sceneId: string; keys: Map<string, string> } | null = null;
  const status = $<HTMLParagraphElement>("status");
  const list = $<HTMLOListElement>("lines");

  const info = (text: string) => {
    status.textContent = text;
    status.classList.remove("error");
  };
  const fail = (text: string) => {
    status.textContent = text;
    status.classList.add("error");
  };
  const characterOf = (id: string): Character | undefined => characters.find((c) => c.id === id);

  function update(index: number, patch: Partial<EditorLine>, rerender = false) {
    lines = lines.map((l, i) => (i === index ? { ...l, ...patch } : l));
    if (rerender) render();
  }

  function options(values: readonly string[], selected: string, empty?: string) {
    return [
      ...(empty !== undefined ? [new Option(empty, "", false, selected === "")] : []),
      ...values.map((v) => new Option(v, v, false, v === selected)),
    ];
  }

  function renderLine(line: EditorLine, index: number): HTMLLIElement {
    const character = characterOf(line.character);
    const who = el("select", { title: "Character" });
    who.append(...characters.map((c) => new Option(c.name, c.id, false, c.id === line.character)));
    if (!character) who.append(new Option(`${line.character} (unknown)`, line.character, false, true));
    who.addEventListener("change", () => update(index, { character: who.value }, true));

    const text = el("input", {
      className: "text",
      type: "text",
      value: line.text,
      placeholder: line.direction ? "Stage direction (logged, not spoken)" : "Line",
    });
    text.addEventListener("input", () => update(index, { text: text.value }));

    const emotion = el("select", { title: "Expression held for the line" });
    emotion.append(...options(PORTABLE_EXPRESSIONS, line.emotion ?? "", "— expression"));
    emotion.addEventListener("change", () => update(index, { emotion: emotion.value || undefined }));

    const gesture = el("select", { title: "Gesture when the line starts" });
    gesture.append(...options(PORTABLE_GESTURES, startGesture(line), "— gesture"));
    gesture.addEventListener("change", () => (lines[index] = withStartGesture(lines[index], gesture.value)));

    const direction = el("input", { type: "checkbox", checked: !!line.direction });
    direction.addEventListener("change", () => update(index, { direction: direction.checked || undefined }, true));

    const voice = VOICE_EDITED.map((field) => {
      const { min, max, step, label } = VOICE_RANGES[field];
      const fallback = character?.voice[field];
      const input = el("input", {
        type: "number",
        min: String(min),
        max: String(max),
        step: String(step),
        value: line.voice[field] === undefined ? "" : String(line.voice[field]),
        // The character's default shows through until the line overrides it.
        placeholder: fallback === undefined ? "engine" : String(fallback),
      });
      input.addEventListener("change", () => {
        const next = { ...lines[index].voice };
        const raw = input.value.trim();
        if (raw === "") delete next[field];
        else if (inRange(field, Number(raw))) next[field] = Number(raw);
        else {
          fail(`${label} must be between ${min} and ${max}.`);
          input.value = lines[index].voice[field] === undefined ? "" : String(lines[index].voice[field]);
          return;
        }
        update(index, { voice: next });
      });
      return el("label", {}, label, input);
    });

    const button = (label: string, title: string, onClick: () => void) => {
      const b = el("button", { type: "button", title, textContent: label });
      b.addEventListener("click", onClick);
      return b;
    };
    const actions = el(
      "div",
      { className: "actions" },
      button("▶", "Play this line", () => void play(index, index + 1)),
      button("▶…", "Play from here", () => void play(index)),
      button("＋", "Add a line below", () => {
        lines = insertLine(lines, index + 1, blankLine(lines[index].character));
        render();
      }),
      button("↑", "Move up", () => {
        lines = moveLine(lines, index, -1);
        render();
      }),
      button("↓", "Move down", () => {
        lines = moveLine(lines, index, 1);
        render();
      }),
      button("✕", "Delete", () => {
        lines = removeLine(lines, index);
        render();
      }),
    );

    const item = el(
      "li",
      { className: `line${line.direction ? " direction" : ""}` },
      el("div", { className: "main" }, who, text, emotion, gesture, el("label", {}, direction, " direction")),
      actions,
      el("div", { className: "voice" }, ...voice, line.audioQuery ? el("small", {}, "uses an edited audio_query") : ""),
    );
    item.dataset.key = line.key;
    return item;
  }

  function render() {
    list.replaceChildren(...lines.map(renderLine));
  }

  /** Plays lines[from..to) as one scene through the stage window. */
  async function play(from = 0, to = lines.length) {
    await stop();
    const run = crypto.randomUUID();
    const chosen = lines.slice(from, to).filter((l) => l.text.trim() || l.audioQuery);
    if (!chosen.length) {
      fail("Nothing to play: the lines are empty.");
      return;
    }
    const keys = new Map<string, string>();
    const payload: EditorPlay = {
      sceneId: run,
      lines: chosen.map((l) => {
        const id = `${run}:${l.key}`;
        keys.set(id, l.key);
        return { ...toRequest(l), id };
      }),
    };
    playing = { sceneId: run, keys };
    for (const item of list.children) item.classList.remove("queued", "preparing", "speaking", "done", "failed");
    await emit(EDITOR_PLAY, payload);
    info(`Playing ${chosen.length} line${chosen.length > 1 ? "s" : ""}…`);
  }

  async function stop() {
    if (playing) await emit(EDITOR_STOP, { sceneId: playing.sceneId });
    playing = null;
  }

  await listen<StageLine>(STAGE_LINE, ({ payload }) => {
    if (!playing || payload.sceneId !== playing.sceneId) return;
    const key = playing.keys.get(payload.lineId);
    const item = [...list.children].find((li) => (li as HTMLElement).dataset.key === key);
    if (!item) return;
    item.classList.remove("queued", "preparing", "speaking", "done", "failed");
    if (payload.state !== "skipped" && payload.state !== "interrupted") item.classList.add(payload.state);
    if (payload.state === "failed") fail(`Line ${[...list.children].indexOf(item) + 1}: ${payload.error ?? "failed"}`);
    if (payload.state === "speaking") item.scrollIntoView({ block: "nearest" });
  });

  $("add").addEventListener("click", () => {
    lines = [...lines, blankLine(lines[lines.length - 1]?.character ?? defaultCharacter)];
    render();
  });
  $("play-all").addEventListener("click", () => void play());
  $("stop").addEventListener("click", () => {
    void stop();
    info("Stopped.");
  });
  $("new").addEventListener("click", () => {
    if (lines.some((l) => l.text.trim()) && !window.confirm("Discard the current scene?")) return;
    lines = [blankLine(defaultCharacter)];
    render();
  });
  $("open").addEventListener("click", async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Scene", extensions: ["json"] }] });
    if (!path) return;
    try {
      const json: unknown = JSON.parse(await invoke<string>("read_scene_file", { path }));
      lines = fromSceneFile(json, defaultCharacter);
      render();
      info(`Opened ${path.split("/").pop()}`);
    } catch (e) {
      fail(`Could not open the scene: ${errorText(e)}`);
    }
  });
  $("save").addEventListener("click", async () => {
    const path = await save({ defaultPath: "scene.json", filters: [{ name: "Scene", extensions: ["json"] }] });
    if (!path) return;
    try {
      await invoke("write_scene_file", { path, contents: `${JSON.stringify(toSceneFile(lines), null, 2)}\n` });
      info(`Saved ${path.split("/").pop()}. POST it to /scenes to perform it from a script.`);
    } catch (e) {
      fail(`Could not save the scene: ${errorText(e)}`);
    }
  });

  // Characters edited in the stage window show up here.
  await store.onKeyChange("characters", (value) => {
    characters = sanitizeCharacters(value);
    render();
  });
  await store.onKeyChange<ThemePreference>("theme", (value) => {
    theme = value ?? "system";
    applyTheme();
  });
  await store.onKeyChange<string>("defaultCharacter", (value) => {
    if (value) defaultCharacter = value;
  });

  render();
}

main().catch((e) => {
  console.error(e);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `Startup failed: ${errorText(e)}`;
    status.classList.add("error");
  }
});
