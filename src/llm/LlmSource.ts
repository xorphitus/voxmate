import type { LineSink, TextSource } from "../speech/TextSource";
import type { ConversationLog, LogEntry } from "../stage/ConversationLog";
import type { Line } from "../stage/Line";
import type { LlmAgent } from "./LlmAgent";

export interface LlmSourceDeps {
  /** The agent for a character id, or for the character on stage. */
  agent(characterId?: string): LlmAgent;
  /** Shared with the stage; replies are built from it and questions go into it. */
  log: ConversationLog;
  onError(error: unknown): void;
}

export interface RespondOptions {
  /** Aborting it abandons this reply only. */
  signal?: AbortSignal;
  /** Lines queued but not heard yet (so not in the log), e.g. the previous turn still playing. */
  pending?: LogEntry[];
}

/**
 * Turns questions into spoken replies by the characters' LLM agents. Each
 * sentence is pushed to the sink as soon as it is complete, so speech starts
 * before the reply has finished. Context comes from the conversation log, so
 * a character also remembers scripted lines and other characters' lines.
 */
export class LlmSource implements TextSource {
  readonly name = "llm";
  private sink: LineSink | null = null;
  private readonly running = new Set<AbortController>();

  constructor(private readonly deps: LlmSourceDeps) {}

  start(sink: LineSink): void {
    this.sink = sink;
  }

  stop(): void {
    this.cancel();
    this.sink = null;
  }

  /** Abandons every reply being generated; what was already spoken stays in the log. */
  cancel(): void {
    for (const controller of this.running) controller.abort();
    this.running.clear();
  }

  /**
   * The user asks; `characterId` (default: the one on stage) answers.
   * Replaces replies still being generated.
   */
  async ask(question: string, characterId?: string): Promise<void> {
    this.cancel();
    this.deps.log.recordUser(question, "ui");
    await this.respond(characterId);
  }

  /**
   * Lets a character (default: the one on stage) speak next, from the log as
   * it is now. Several characters can generate at once.
   */
  async respond(characterId?: string, options: RespondOptions = {}): Promise<Line[]> {
    const controller = new AbortController();
    this.running.add(controller);
    const { signal } = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const queued: Line[] = [];
    try {
      const agent = this.deps.agent(characterId);
      const logged = this.deps.log.entries();
      const seen = new Set(logged.map((e) => e.lineId));
      const context = [...logged, ...(options.pending ?? []).filter((e) => !seen.has(e.lineId))];
      for await (const draft of agent.respond(context, signal)) {
        if (signal.aborted) break;
        const line = this.sink?.({ ...draft, source: this.name });
        if (line) queued.push(line);
      }
    } catch (e) {
      if (!signal.aborted) this.deps.onError(e);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.running.delete(controller);
    }
    return queued;
  }
}
