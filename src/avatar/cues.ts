/**
 * Cues: what a character does while it speaks. Lines carry them (scripts, the
 * API, LLM tags) and StageView fires them against the playback clock.
 */

/** The shared vocabulary; each character can map these onto its model's own names. */
export const PORTABLE_EXPRESSIONS = ["neutral", "happy", "sad", "angry", "surprised", "relaxed"] as const;
export const PORTABLE_GESTURES = ["nod", "shake", "tilt"] as const;

/**
 * When a cue fires: at the start or end of the line, after `n` seconds, or
 * when accent phrase `phrase` (0-based, from the line's `audio_query`) starts.
 */
export type CueTime = "start" | "end" | number | { phrase: number };

export interface Cue {
  at: CueTime;
  /** A portable name, or one of the model's own expressions. "neutral" clears. */
  expression?: string;
  /** A portable gesture, or one of the model's own motions (Live2D motion group). */
  gesture?: string;
  /** A character id to look at, or "camera" for the user. */
  lookAt?: string;
}

export interface ScheduledCue {
  /** Seconds into the line, or "end". */
  time: number | "end";
  cue: Cue;
}

/**
 * Resolves cue times against the line's accent phrases and puts them in
 * firing order. `emotion` becomes an expression held from the start. A phrase
 * index past the last phrase fires at the end.
 */
export function scheduleCues(cues: Cue[] | undefined, emotion: string | undefined, phrases: number[]): ScheduledCue[] {
  const scheduled: ScheduledCue[] = [];
  if (emotion) scheduled.push({ time: 0, cue: { at: "start", expression: emotion } });
  for (const cue of cues ?? []) {
    const { at } = cue;
    const time =
      at === "start"
        ? 0
        : at === "end"
          ? "end"
          : typeof at === "number"
            ? Math.max(0, at)
            : (phrases[at.phrase] ?? "end");
    scheduled.push({ time, cue });
  }
  const order = (t: number | "end") => (t === "end" ? Infinity : t);
  // Stable, so cues at the same time keep their order.
  return scheduled.sort((a, b) => order(a.time) - order(b.time));
}

/** A character's name for `name` (portable names map to model names), or `name` itself. */
export function modelName(name: string, names: Record<string, string> | undefined): string {
  return names?.[name] || name;
}
