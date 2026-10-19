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
  /** Typed by the user (e.g. a question to a character), not performed. */
  user?: boolean;
}

export const MAX_LOG_ENTRIES = 1000;

/**
 * The shared record of what was actually performed, whoever produced it.
 * Lines are appended once spoken; lines dropped before playing, or that
 * failed, are not.
 */
export class ConversationLog {
  private log: LogEntry[] = [];
  private listeners = new Set<(entry: LogEntry) => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = MAX_LOG_ENTRIES,
  ) {}

  /** Feed it every StagePlayer event. Returns the entry it added, if any. */
  record({ line, state }: LineEvent): LogEntry | null {
    if (state !== "done" && state !== "interrupted") return null;
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
    return this.push(entry);
  }

  private push(entry: LogEntry): LogEntry {
    this.log.push(entry);
    if (this.log.length > this.max) this.log.splice(0, this.log.length - this.max);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  /** Records something the user typed, e.g. a question, so characters can answer it. */
  recordUser(text: string, source: string): LogEntry {
    return this.push({ lineId: crypto.randomUUID(), character: "", text, source, time: this.now(), user: true });
  }

  /** Called with every entry as it is added. */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
