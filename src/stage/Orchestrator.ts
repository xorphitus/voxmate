import type { LogEntry } from "./ConversationLog";
import type { Line, LineEvent } from "./Line";

export interface Participant {
  id: string;
  name: string;
}

/**
 * Who should speak after `text` by `speakerId`: the participant it names
 * first (other than the speaker), if any.
 */
export function addressed(text: string, participants: Participant[], speakerId?: string): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const p of participants) {
    if (p.id === speakerId || !p.name) continue;
    const at = text.indexOf(p.name);
    if (at >= 0 && (!best || at < best.at)) best = { id: p.id, at };
  }
  return best?.id;
}

/**
 * The next speaker in a free conversation: whoever the latest line names,
 * else the participant after the last one who spoke (round-robin).
 */
export function nextSpeaker(entries: LogEntry[], participants: Participant[]): string | undefined {
  if (participants.length === 0) return undefined;
  const spoken = entries.filter((e) => !e.direction);
  const latest = spoken[spoken.length - 1];
  if (latest) {
    const named = addressed(latest.text, participants, latest.user ? undefined : latest.character);
    if (named) return named;
  }
  const lastSpeaker = [...spoken].reverse().find((e) => participants.some((p) => p.id === e.character));
  const i = lastSpeaker ? participants.findIndex((p) => p.id === lastSpeaker.character) : -1;
  return participants[(i + 1) % participants.length].id;
}

export interface OrchestratorDeps {
  participants(): Participant[];
  /** What was heard so far. */
  log(): LogEntry[];
  /** Generates one turn; resolves with the lines it queued once its text is complete. */
  respond(characterId: string, signal: AbortSignal, pending: LogEntry[]): Promise<Line[]>;
  /** Stage line events. */
  onLineEvent(listener: (event: LineEvent) => void): () => void;
  /** Drops queued (not yet spoken) lines; the current line finishes. */
  skipQueued(match: (line: Line) => boolean): void;
  /** Adds a stage direction to the log, e.g. the topic. */
  direct(text: string): void;
  onStateChange?(state: OrchestratorState): void;
  now?(): number;
}

export interface FreeOptions {
  maxTurns: number;
  maxMinutes: number;
  /** Becomes a stage direction before the first turn. */
  topic?: string;
}

export type StopReason = "stopped" | "max-turns" | "max-minutes" | "silent" | "no-participants";

export interface OrchestratorState {
  running: boolean;
  turns: number;
  /** Paused while a script plays. */
  paused: boolean;
  /** Why the last conversation ended, once it has. */
  stopReason?: StopReason;
}

const isFinal = (state: LineEvent["state"]) =>
  state === "done" || state === "interrupted" || state === "skipped" || state === "failed";

/**
 * Lets characters keep talking with each other ("free" mode).
 *
 * Turn N+1 is generated as soon as turn N's text is complete, so the LLM
 * works while N plays; it waits for turn N-1 to be heard, so at most one turn
 * is queued ahead. A user line cancels the turn being generated and the next
 * turn answers it. A script (a line with a scene id) pauses the conversation:
 * the current line finishes, queued autonomous lines are dropped, and the
 * conversation resumes with the scene in the log once it has played.
 */
export class Orchestrator {
  private state: OrchestratorState = { running: false, turns: 0, paused: false };
  private run: AbortController | null = null;
  /** The turn being generated; aborted on interjection or a script. */
  private turn: AbortController | null = null;
  /** Lines this orchestrator queued that were not heard yet, by id. */
  private unheard = new Map<string, Line>();
  /** Script lines queued or playing. */
  private scriptLines = new Set<string>();
  private wake: (() => void) | null = null;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.unsubscribe = deps.onLineEvent((e) => this.onLineEvent(e));
  }

  get current(): OrchestratorState {
    return { ...this.state };
  }

  /** Starts a free conversation; a running one is replaced. */
  start(options: FreeOptions): void {
    this.stop();
    const run = new AbortController();
    this.run = run;
    this.update({ running: true, turns: 0, paused: this.scriptLines.size > 0, stopReason: undefined });
    void this.loop(run.signal, options);
  }

  stop(): void {
    this.end("stopped");
  }

  /** The user said something: drop the turn being generated so the next one answers it. */
  interject(): void {
    this.turn?.abort();
    this.notify();
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }

  private end(reason: StopReason): void {
    if (!this.run) return;
    this.run.abort();
    this.turn?.abort();
    this.run = null;
    this.update({ running: false, stopReason: reason });
    this.notify();
  }

  private onLineEvent({ line, state }: LineEvent): void {
    if (line.sceneId !== undefined) {
      if (state === "queued") {
        this.scriptLines.add(line.id);
        if (this.run) this.pauseForScript();
      } else if (isFinal(state)) {
        this.scriptLines.delete(line.id);
      }
      this.update({ paused: this.scriptLines.size > 0 });
    }
    if (isFinal(state)) this.unheard.delete(line.id);
    this.notify();
  }

  private pauseForScript(): void {
    this.turn?.abort();
    const ours = new Set(this.unheard.keys());
    this.deps.skipQueued((line) => ours.has(line.id));
  }

  private async loop(signal: AbortSignal, { maxTurns, maxMinutes, topic }: FreeOptions): Promise<void> {
    const startedAt = this.now();
    if (topic?.trim()) this.deps.direct(topic.trim());
    let lastTurn = new Set<string>();
    while (!signal.aborted) {
      // At most one turn queued ahead, and none while a script plays.
      await this.until(
        signal,
        () => this.scriptLines.size === 0 && [...this.unheard.keys()].every((id) => lastTurn.has(id)),
      );
      if (signal.aborted) return;
      if (this.state.turns >= maxTurns) return this.end("max-turns");
      if (this.now() - startedAt >= maxMinutes * 60_000) return this.end("max-minutes");

      const participants = this.deps.participants();
      const pending = [...this.unheard.values()].map(toEntry);
      const speaker = nextSpeaker([...this.deps.log(), ...pending], participants);
      if (!speaker || participants.length < 2) return this.end("no-participants");

      const turn = new AbortController();
      this.turn = turn;
      const onStop = () => turn.abort();
      signal.addEventListener("abort", onStop, { once: true });
      const lines = await this.deps.respond(speaker, turn.signal, pending);
      signal.removeEventListener("abort", onStop);
      if (this.turn === turn) this.turn = null;
      if (signal.aborted) return;
      if (turn.signal.aborted) {
        // Interjection or script: drop what this turn queued and go again.
        const dropped = new Set(lines.map((l) => l.id));
        this.deps.skipQueued((line) => dropped.has(line.id));
        continue;
      }
      if (lines.length === 0) return this.end("silent");
      for (const line of lines) this.unheard.set(line.id, line);
      lastTurn = new Set(lines.map((l) => l.id));
      this.update({ turns: this.state.turns + 1 });
    }
  }

  /** Resolves once `ready()` holds or `signal` aborts, re-checking on every event. */
  private async until(signal: AbortSignal, ready: () => boolean): Promise<void> {
    while (!signal.aborted && !ready()) {
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private update(patch: Partial<OrchestratorState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof OrchestratorState)[]).some((k) => next[k] !== this.state[k]);
    this.state = next;
    if (changed) this.deps.onStateChange?.(this.current);
  }
}

function toEntry(line: Line): LogEntry {
  return { lineId: line.id, character: line.character, text: line.text, source: line.source, time: 0 };
}
