import "../styles.css";
import "./editor.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { type Cue, PORTABLE_EXPRESSIONS, PORTABLE_GESTURES } from "../avatar/cues";
import { type Character, sanitizeCharacters } from "../characters";
import { SETTINGS_FILE } from "../config";
import { followTheme, type ThemePreference } from "../ui/theme";
import { inRange, mergeVoice, sanitizeVoice, VOICE_RANGES, type VoiceField } from "../voice/params";
import type { AccentPhrase, AudioQuery } from "../voice/timeline";
import { changeAccent, isVoiced, LENGTH_RANGE, type MoraUpdate, PITCH_RANGE, setMora } from "./accent";
import {
  atOptions,
  decodeAt,
  encodeAt,
  isEmptyCue,
  type ModelNames,
  nameOptions,
  phraseLabels,
  storedCues,
  updateCue,
} from "./cueTrack";
import { importVvproj } from "./vvproj";
import { EDITOR_PLAY, EDITOR_STOP, type EditorPlay, STAGE_LINE, type StageLine } from "./bridge";
import {
  blankLine,
  type EditorLine,
  exportLines,
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
/** Silence between lines in a WAV export, on top of each line's own pre/post silence. */
const EXPORT_GAP_SECONDS = 0.3;

/** A cue in a tooltip: "happy, nod, look at camera". */
const describeCue = (c: Cue) =>
  [c.expression, c.gesture, c.lookAt && `look at ${c.lookAt}`].filter(Boolean).join(", ");

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

  /** Lines (by key) whose accent panel is open. */
  const accentOpen = new Set<string>();

  function update(index: number, patch: Partial<EditorLine>, rerender = false) {
    lines = lines.map((l, i) => (i === index ? { ...l, ...patch } : l));
    if (rerender) render();
  }

  /** For results that arrive after an await, when the line may have moved. */
  function updateByKey(key: string, patch: Partial<EditorLine>) {
    const index = lines.findIndex((l) => l.key === key);
    if (index >= 0) update(index, patch, true);
  }

  /** The speaker the stage would use for the line. */
  function speakerOf(line: EditorLine): number {
    const speaker = line.speaker ?? characterOf(line.character)?.speaker;
    if (speaker === undefined) throw new Error(`unknown character "${line.character}"`);
    return speaker;
  }

  const updateMoras = (line: EditorLine) => (update: MoraUpdate, accentPhrases: AccentPhrase[]) =>
    invoke<AccentPhrase[]>("voicevox_update_moras", { update, accentPhrases, speaker: speakerOf(line) });

  /** Opens or closes the accent panel, asking the engine for a query the first time. */
  async function toggleAccent(index: number) {
    const line = lines[index];
    if (accentOpen.delete(line.key)) {
      render();
      return;
    }
    if (!line.audioQuery) {
      if (!line.text.trim()) {
        fail("Write the line before editing its accent.");
        return;
      }
      try {
        // The character's voice is baked into the query: an edited query is played as is.
        const voice = mergeVoice(characterOf(line.character)?.voice, sanitizeVoice(line.voice));
        const query = await invoke<AudioQuery>("voicevox_audio_query", {
          text: line.text.trim(),
          speaker: speakerOf(line),
          voice,
        });
        updateByKey(line.key, { audioQuery: query });
      } catch (e) {
        fail(`Could not get the accent: ${errorText(e)}`);
        return;
      }
    }
    accentOpen.add(line.key);
    render();
  }

  async function moveAccent(line: EditorLine, phrase: number, accent: number) {
    if (!line.audioQuery) return;
    try {
      updateByKey(line.key, { audioQuery: await changeAccent(line.audioQuery, phrase, accent, updateMoras(line)) });
    } catch (e) {
      fail(`Could not change the accent: ${errorText(e)}`);
    }
  }

  function renderAccent(line: EditorLine, index: number): HTMLElement {
    const query = line.audioQuery;
    if (!query) return el("div");
    const phrases = query.accent_phrases.map((phrase, p) => {
      const moras = phrase.moras.map((mora, m) => {
        const slider = (field: "pitch" | "vowel_length", range: typeof PITCH_RANGE, title: string) => {
          const input = el("input", {
            type: "range",
            className: field === "pitch" ? "pitch" : "length",
            min: String(range.min),
            max: String(range.max),
            step: String(range.step),
            value: String(mora[field]),
            title: `${title} ${mora[field].toFixed(3)}`,
            disabled: field === "pitch" && !isVoiced(mora),
          });
          input.addEventListener("input", () => {
            const current = lines[index].audioQuery;
            if (!current) return;
            update(index, { audioQuery: setMora(current, p, m, { [field]: Number(input.value) }) });
            input.title = `${title} ${Number(input.value).toFixed(3)}`;
          });
          return input;
        };
        const text = el("button", {
          type: "button",
          className: `mora${m + 1 === phrase.accent ? " accent" : ""}`,
          textContent: mora.text,
          title: "Put the accent here",
        });
        text.addEventListener("click", () => void moveAccent(lines[index], p, m + 1));
        return el(
          "div",
          { className: "mora-column" },
          slider("pitch", PITCH_RANGE, "Pitch"),
          text,
          slider("vowel_length", LENGTH_RANGE, "Length (s)"),
        );
      });
      const reset = el("button", { type: "button", className: "reset", textContent: "↺", title: "Reset this phrase" });
      reset.addEventListener("click", () => void moveAccent(lines[index], p, phrase.accent));
      const cued = (line.cues ?? []).filter(
        (c) => typeof c.at === "object" && c.at.phrase === p && !isEmptyCue(c),
      );
      return el(
        "div",
        { className: "phrase" },
        ...(cued.length
          ? [el("span", { className: "cue-mark", textContent: "◆", title: cued.map(describeCue).join("\n") })]
          : []),
        ...moras,
        reset,
        ...(phrase.pause_mora ? [el("span", { className: "pause", textContent: "、" })] : []),
      );
    });
    const drop = el("button", { type: "button", textContent: "Drop edits", title: "Go back to the engine's accent" });
    drop.addEventListener("click", () => {
      accentOpen.delete(line.key);
      update(index, { audioQuery: undefined }, true);
    });
    return el("div", { className: "accent-panel" }, ...phrases, drop);
  }

  /** Lines (by key) whose cue panel is open. */
  const cuesOpen = new Set<string>();
  /** Model-specific names by character id, as the stage window reports them. */
  let modelNames: Record<string, ModelNames> = {};
  /** Phrase labels from a preview query, for lines without an edited one. */
  const previews = new Map<string, { text: string; labels: string[] }>();

  async function refreshModelNames() {
    try {
      modelNames = await invoke<Record<string, ModelNames>>("stage_character_capabilities");
    } catch {
      modelNames = {};
    }
  }

  function labelsOf(line: EditorLine): string[] {
    if (line.audioQuery) return phraseLabels(line.audioQuery);
    const preview = previews.get(line.key);
    return preview?.text === line.text ? preview.labels : [];
  }

  /** Fetches the phrases of a line without an edited query (not stored on the line). */
  async function loadPhrases(line: EditorLine) {
    if (line.audioQuery || !line.text.trim() || previews.get(line.key)?.text === line.text) return;
    try {
      const query = await invoke<AudioQuery>("voicevox_audio_query", { text: line.text.trim(), speaker: speakerOf(line) });
      previews.set(line.key, { text: line.text, labels: phraseLabels(query) });
      render();
    } catch {
      // Without the engine, phrases are offered by number only.
    }
  }

  async function toggleCues(index: number) {
    const line = lines[index];
    if (cuesOpen.delete(line.key)) {
      render();
      return;
    }
    cuesOpen.add(line.key);
    await refreshModelNames();
    render();
    await loadPhrases(line);
  }

  function renderCues(line: EditorLine, index: number): HTMLElement {
    const cues = line.cues ?? [];
    const labels = labelsOf(line);
    const own = modelNames[line.character];
    const setCues = (next: Cue[]) => update(index, { cues: storedCues(next) }, true);
    const current = () => lines[index].cues ?? [];

    const rows = cues.map((cue, i) => {
      const at = el("select", { title: "When" });
      at.append(...atOptions(labels, cue.at).map((o) => new Option(o.label, o.value, false, o.value === encodeAt(cue.at))));
      const seconds = el("input", {
        type: "number",
        min: "0",
        step: "0.1",
        value: typeof cue.at === "number" ? String(cue.at) : "0",
        hidden: typeof cue.at !== "number",
        title: "Seconds after the line starts",
      });
      const commitAt = () => setCues(updateCue(current(), i, { at: decodeAt(at.value, Number(seconds.value)) }));
      at.addEventListener("change", commitAt);
      seconds.addEventListener("change", commitAt);

      const pick = (field: "expression" | "gesture", values: string[], empty: string) => {
        const s = el("select", { title: field === "expression" ? "Expression" : "Gesture" });
        s.append(...options(values, cue[field] ?? "", empty));
        s.addEventListener("change", () => setCues(updateCue(current(), i, { [field]: s.value })));
        return s;
      };
      const look = el("select", { title: "Look at" });
      const targets = characters.filter((c) => c.id !== line.character).map((c) => [c.id, c.name]);
      if (cue.lookAt && cue.lookAt !== "camera" && !targets.some(([id]) => id === cue.lookAt)) {
        targets.push([cue.lookAt, `${cue.lookAt} (unknown)`]);
      }
      look.append(
        ...[["", "— look at"], ["camera", "camera (you)"], ...targets].map(
          ([value, label]) => new Option(label, value, false, value === (cue.lookAt ?? "")),
        ),
      );
      look.addEventListener("change", () => setCues(updateCue(current(), i, { lookAt: look.value })));

      const remove = el("button", { type: "button", textContent: "✕", title: "Remove this cue" });
      remove.addEventListener("click", () => setCues(current().filter((_, j) => j !== i)));
      return el(
        "div",
        { className: "cue" },
        at,
        seconds,
        pick("expression", nameOptions(PORTABLE_EXPRESSIONS, own?.expressions), "— expression"),
        pick("gesture", nameOptions(PORTABLE_GESTURES, own?.gestures), "— gesture"),
        look,
        remove,
      );
    });

    const add = el("button", { type: "button", textContent: "+ Cue" });
    add.addEventListener("click", () => setCues([...current(), { at: "start" }]));
    const hint =
      !labels.length && line.text.trim()
        ? el("small", {}, "Phrases are numbered only: their text needs the VOICEVOX engine.")
        : "";
    return el("div", { className: "cue-panel" }, ...rows, el("div", {}, add, " ", hint));
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
    // An edited query is stale once the text changes.
    let committed = line.text;
    text.addEventListener("change", () => {
      if (!lines[index].audioQuery) {
        // The phrase labels of the cue panel follow the text.
        if (cuesOpen.has(line.key)) void loadPhrases(lines[index]);
        return;
      }
      if (text.value === committed) return;
      if (window.confirm("The text changed, so the edited accent no longer fits. Drop it?")) {
        accentOpen.delete(line.key);
        committed = text.value;
        update(index, { audioQuery: undefined }, true);
      } else {
        text.value = committed;
        update(index, { text: committed });
      }
    });

    const emotion = el("select", { title: "Expression held for the line" });
    emotion.append(...options(nameOptions(PORTABLE_EXPRESSIONS, modelNames[line.character]?.expressions), line.emotion ?? "", "— expression"));
    emotion.addEventListener("change", () => update(index, { emotion: emotion.value || undefined }));

    const gesture = el("select", { title: "Gesture when the line starts" });
    gesture.append(...options(nameOptions(PORTABLE_GESTURES, modelNames[line.character]?.gestures), startGesture(line), "— gesture"));
    gesture.addEventListener("change", () => {
      lines[index] = withStartGesture(lines[index], gesture.value);
      // The cue panel shows the same cue.
      if (cuesOpen.has(line.key)) render();
    });

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
      button("⤓", "Export this line as WAV", () => void exportWav(index, index + 1)),
      button("♪", "Edit accent and intonation", () => void toggleAccent(index)),
      button("◆", "Cues: expressions, gestures and gaze during the line", () => void toggleCues(index)),
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
      ...(accentOpen.has(line.key) && line.audioQuery ? [renderAccent(line, index)] : []),
      ...(cuesOpen.has(line.key) ? [renderCues(line, index)] : []),
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

  /** Synthesizes lines[from..to) into one WAV file the user picks. */
  async function exportWav(from = 0, to = lines.length) {
    let chosen;
    try {
      chosen = exportLines(lines.slice(from, to), characters);
    } catch (e) {
      fail(`Cannot export: ${errorText(e)}`);
      return;
    }
    if (!chosen.length) {
      fail("Nothing to export: no spoken lines.");
      return;
    }
    const path = await save({ defaultPath: "scene.wav", filters: [{ name: "WAV", extensions: ["wav"] }] });
    if (!path) return;
    info(`Synthesizing ${chosen.length} line${chosen.length > 1 ? "s" : ""}…`);
    try {
      await invoke("export_wav", { path, lines: chosen, gapSeconds: EXPORT_GAP_SECONDS });
      info(`Exported ${path.split("/").pop()}`);
    } catch (e) {
      fail(`Could not export: ${errorText(e)}`);
    }
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
  $("export").addEventListener("click", () => void exportWav());
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
    const path = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Scene or VOICEVOX project", extensions: ["json", "vvproj"] },
        { name: "Scene", extensions: ["json"] },
        { name: "VOICEVOX project (talk track)", extensions: ["vvproj"] },
      ],
    });
    if (!path) return;
    try {
      const json: unknown = JSON.parse(await invoke<string>("read_scene_file", { path }));
      // A VOICEVOX project is imported; save it as a scene to keep it.
      lines = path.endsWith(".vvproj") ? importVvproj(json, characters, defaultCharacter) : fromSceneFile(json, defaultCharacter);
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
  // Model-specific names, once the stage window has reported them.
  void refreshModelNames().then(render);
}

main().catch((e) => {
  console.error(e);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `Startup failed: ${errorText(e)}`;
    status.classList.add("error");
  }
});
