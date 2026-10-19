import type { Cue, CueTime } from "../avatar/cues";
import type { AudioQuery } from "../voice/timeline";

/** What a character's model offers (`Capabilities` in src-tauri/src/stage.rs). */
export interface ModelNames {
  expressions: string[];
  gestures: string[];
}

/** Each accent phrase's kana, for labeling `{ phrase: n }`. */
export function phraseLabels(query: AudioQuery): string[] {
  return query.accent_phrases.map((p) => p.moras.map((m) => m.text).join(""));
}

/**
 * A cue time as a select value: "start", "end", "s" (seconds, with the number
 * in its own input) or "p<n>" for accent phrase n.
 */
export function encodeAt(at: CueTime): string {
  if (typeof at === "number") return "s";
  if (typeof at === "object") return `p${at.phrase}`;
  return at;
}

/** The inverse of `encodeAt`; `seconds` is used for "s". */
export function decodeAt(value: string, seconds: number): CueTime {
  if (value === "start" || value === "end") return value;
  if (value === "s") return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const phrase = Number(value.slice(1));
  return { phrase: Number.isInteger(phrase) && phrase >= 0 ? phrase : 0 };
}

/** The choices for a cue time: start, each phrase, end, seconds. */
export function atOptions(labels: string[], at?: CueTime): { value: string; label: string }[] {
  // Keep a phrase the current query doesn't have, so a loaded cue isn't lost.
  const count = Math.max(labels.length, at && typeof at === "object" ? at.phrase + 1 : 0);
  return [
    { value: "start", label: "start" },
    ...Array.from({ length: count }, (_, n) => ({
      value: `p${n}`,
      label: `phrase ${n + 1}${labels[n] ? `: ${labels[n]}` : ""}`,
    })),
    { value: "end", label: "end" },
    { value: "s", label: "seconds" },
  ];
}

/** Portable names first, then the model's own that aren't portable ones. */
export function nameOptions(portable: readonly string[], own: string[] = []): string[] {
  return [...new Set([...portable, ...own])];
}

/** `cues` with cue `index` patched; empty fields are removed. */
export function updateCue(cues: Cue[], index: number, patch: Partial<Cue>): Cue[] {
  return cues.map((c, i) => {
    if (i !== index) return c;
    const next: Cue = { ...c, ...patch };
    for (const key of ["expression", "gesture", "lookAt"] as const) if (!next[key]) delete next[key];
    return next;
  });
}

/** Cues as a line stores them: undefined when there are none. */
export const storedCues = (cues: Cue[]): Cue[] | undefined => (cues.length ? cues : undefined);

/** Whether a cue does anything (an empty row is dropped on save). */
export const isEmptyCue = (cue: Cue) => !cue.expression && !cue.gesture && cue.lookAt === undefined;
