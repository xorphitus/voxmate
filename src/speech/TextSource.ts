/** One thing to say. */
export interface Utterance {
  text: string;
  /** VOICEVOX style id; falls back to the selected speaker. */
  speaker?: number;
  /** Name of the TextSource it came from, for logs/UI. */
  source?: string;
}

export type UtteranceSink = (utterance: Utterance) => void;

/**
 * Anything that produces text to speak: the UI, the local HTTP API, and later
 * an LLM that streams sentences. Sources only push into the sink; they never
 * touch voice or avatar code.
 */
export interface TextSource {
  readonly name: string;
  start(sink: UtteranceSink): void | Promise<void>;
  stop(): void | Promise<void>;
}
