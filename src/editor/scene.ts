import type { Cue } from "../avatar/cues";
import { sanitizeVoice, type VoiceParams } from "../voice/params";
import type { AudioQuery } from "../voice/timeline";

/**
 * One line in the editor. Saved files use the scene API's JSON
 * (`POST /scenes`, `LineRequest` in src-tauri/src/api.rs), so a file can be
 * posted as is and a script's body opened in the editor.
 */
export interface EditorLine {
  /** Local id, for the DOM and for matching playback events. */
  key: string;
  character: string;
  text: string;
  voice: VoiceParams;
  emotion?: string;
  direction?: boolean;
  cues?: Cue[];
  /** Kept from loaded files; the editor doesn't edit it yet. */
  audioQuery?: AudioQuery;
  speaker?: number;
}

/** The scene file / `POST /scenes` body. */
export interface SceneFile {
  lines: Record<string, unknown>[];
  placement?: "append" | "next";
}

let nextKey = 1;
export const newKey = () => `l${nextKey++}`;

export function blankLine(character: string): EditorLine {
  return { key: newKey(), character, text: "", voice: {} };
}

export function insertLine(lines: EditorLine[], index: number, line: EditorLine): EditorLine[] {
  return [...lines.slice(0, index), line, ...lines.slice(index)];
}

export function moveLine(lines: EditorLine[], index: number, by: -1 | 1): EditorLine[] {
  const to = index + by;
  if (to < 0 || to >= lines.length) return lines;
  const next = [...lines];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removeLine(lines: EditorLine[], index: number): EditorLine[] {
  return lines.filter((_, i) => i !== index);
}

/** The gesture played when the line starts, as the editor shows it. */
export function startGesture(line: EditorLine): string {
  return line.cues?.find((c) => c.at === "start" && c.gesture)?.gesture ?? "";
}

export function withStartGesture(line: EditorLine, gesture: string): EditorLine {
  const others = (line.cues ?? []).filter((c) => !(c.at === "start" && c.gesture));
  const cues = gesture ? [{ at: "start" as const, gesture }, ...others] : others;
  return { ...line, cues: cues.length ? cues : undefined };
}

/** A line as `LineRequest` JSON, without empty fields. */
export function toRequest(line: EditorLine): Record<string, unknown> {
  const voice = sanitizeVoice(line.voice);
  return {
    character: line.character,
    text: line.text.trim(),
    ...(Object.keys(voice).length && { voice }),
    ...(line.emotion && { emotion: line.emotion }),
    ...(line.direction && { direction: true }),
    ...(line.cues?.length && { cues: line.cues }),
    ...(line.audioQuery && { audioQuery: line.audioQuery }),
    ...(line.speaker !== undefined && { speaker: line.speaker }),
  };
}

/** Lines that would be spoken or logged; blank ones without a query are left out. */
export function toSceneFile(lines: EditorLine[]): SceneFile {
  return { lines: lines.filter((l) => l.text.trim() || l.audioQuery).map(toRequest) };
}

/**
 * Reads a scene file (or a `POST /scenes` body). Lines without a character
 * get `fallbackCharacter`. Throws a readable error for anything else.
 */
export function fromSceneFile(json: unknown, fallbackCharacter: string): EditorLine[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as SceneFile).lines)) {
    throw new Error('not a scene file: expected {"lines": [...]}');
  }
  return (json as SceneFile).lines.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`lines[${i}] is not an object`);
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text : "";
    if (!text && typeof r.audioQuery !== "object") throw new Error(`lines[${i}] has no text`);
    return {
      key: newKey(),
      character: typeof r.character === "string" ? r.character : fallbackCharacter,
      text,
      voice: sanitizeVoice(r.voice),
      ...(typeof r.emotion === "string" && { emotion: r.emotion }),
      ...(r.direction === true && { direction: true }),
      ...(Array.isArray(r.cues) && { cues: r.cues as Cue[] }),
      ...(typeof r.audioQuery === "object" && r.audioQuery !== null && { audioQuery: r.audioQuery as AudioQuery }),
      ...(typeof r.speaker === "number" && { speaker: r.speaker }),
    };
  });
}
