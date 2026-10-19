import type { LineEvent } from "./Line";

/** Something that was said (or a stage direction), in the order it happened. */
export interface LogEntry {
  lineId: string;
  character: string;
  text: string;
  source: string;
  /** ms since the epoch, when the line ended. */
  time: number;
  sceneId?: string;
  /** Stopped partway; listeners may not have heard all of `text`. */
  interrupted?: boolean;
  direction?: boolean;
}

export const MAX_LOG_ENTRIES = 1000;

/**
 * The shared record of what was actually performed, whoever produced it.
 * Lines are appended once spoken; lines dropped before playing, or that
 * failed, are not.
 */
export class ConversationLog {
  private log: LogEntry[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = MAX_LOG_ENTRIES,
  ) {}

  /** Feed it every StagePlayer event. */
  record({ line, state }: LineEvent): void {
    if (state !== "done" && state !== "interrupted") return;
    const entry: LogEntry = {
      lineId: line.id,
      character: line.character,
      text: line.text,
      source: line.source,
      time: this.now(),
    };
    if (line.sceneId !== undefined) entry.sceneId = line.sceneId;
    if (state === "interrupted") entry.interrupted = true;
    if (line.direction) entry.direction = true;
    this.log.push(entry);
    if (this.log.length > this.max) this.log.splice(0, this.log.length - this.max);
  }

  /** The most recent `count` entries (all if omitted), oldest first. */
  entries(count?: number): LogEntry[] {
    if (count === undefined) return [...this.log];
    // slice(-0) would return everything.
    return count > 0 ? this.log.slice(-count) : [];
  }

  clear(): void {
    this.log = [];
  }
}
