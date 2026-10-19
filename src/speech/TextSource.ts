import type { Line, LineDraft } from "../stage/Line";

/** Queues a line on stage; returns it with its id, or null if it was blank. */
export type LineSink = (line: LineDraft) => Line | null;

/**
 * Anything that produces lines: the UI, the local HTTP API, the LLM. Sources
 * only push into the sink; they never touch voice or avatar code.
 */
export interface TextSource {
  readonly name: string;
  start(sink: LineSink): void | Promise<void>;
  stop(): void | Promise<void>;
}
