import type { AudioQuery } from "../voice/timeline";
import type { Cue } from "../avatar/cues";
import type { VoiceParams } from "../voice/params";

/**
 * One line performed on stage. Every producer (UI, Local API, LLM, later
 * scripts) emits lines, and the StagePlayer performs them in order.
 */
export interface Line {
  id: string;
  /** Character id. The player fills in the character on stage when a draft names none. */
  character: string;
  text: string;
  /** VOICEVOX style id; overrides the character's speaker. */
  speaker?: number;
  /** Overrides the character's default voice, field by field. */
  voice?: VoiceParams;
  /**
   * A complete VOICEVOX `audio_query` to synthesize instead of making one
   * from `text`. `voice` still overrides its values; the character's default
   * voice does not. `text` is then only what the log shows.
   */
  audioQuery?: AudioQuery;
  /** Name of the TextSource it came from, for logs/UI. */
  source: string;
  /** Lines of one scene are queued together and can be cancelled together. */
  sceneId?: string;
  /** A stage direction is not spoken; it only goes into the conversation log. */
  direction?: boolean;
  /** An expression held for the whole line. */
  emotion?: string;
  /** What the speaker does while speaking (see scheduleCues). */
  cues?: Cue[];
}

/** What producers emit; the player assigns `id` and the default character. */
export type LineDraft = Omit<Line, "id" | "character"> & { id?: string; character?: string };

export interface Scene {
  id?: string;
  source: string;
  lines: Omit<LineDraft, "source" | "sceneId">[];
}

/**
 * - `queued`: accepted, waiting for its turn
 * - `preparing`: synthesis started (may overlap the previous line)
 * - `speaking`: playback started (a stage direction goes straight to `done`)
 * - `done`: played to the end
 * - `interrupted`: stopped while speaking
 * - `skipped`: removed before it was spoken
 * - `failed`: synthesis or playback threw
 */
export type LineState = "queued" | "preparing" | "speaking" | "done" | "interrupted" | "skipped" | "failed";

export interface LineEvent {
  line: Line;
  state: LineState;
  /** Set when `state` is `failed`. */
  error?: unknown;
}

/** Where a line or scene goes in the queue. */
export type QueuePosition =
  /** After everything already queued. */
  | "end"
  /** Right after the current line, and after the rest of its scene so scenes stay together. */
  | "next";
