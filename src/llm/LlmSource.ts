import type { LineSink, TextSource } from "../speech/TextSource";
import type { ConversationLog } from "../stage/ConversationLog";
import type { LlmAgent } from "./LlmAgent";

export interface LlmSourceDeps {
  /** The agent for a character id, or for the character on stage. */
  agent(characterId?: string): LlmAgent;
  /** Shared with the stage; replies are built from it and questions go into it. */
  log: ConversationLog;
  onError(error: unknown): void;
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

  /** The user asks; the character on stage answers. Replaces replies still being generated. */
  async ask(question: string): Promise<void> {
    this.cancel();
    this.deps.log.recordUser(question, "ui");
    await this.respond();
  }

  /**
   * Lets a character (default: the one on stage) speak next, from the log as
   * it is now. Several characters can generate at once.
   */
  async respond(characterId?: string): Promise<void> {
    const controller = new AbortController();
    this.running.add(controller);
    const { signal } = controller;
    try {
      const agent = this.deps.agent(characterId);
      for await (const line of agent.respond(this.deps.log.entries(), signal)) {
        if (signal.aborted) break;
        this.sink?.({ ...line, source: this.name });
      }
    } catch (e) {
      if (!signal.aborted) this.deps.onError(e);
    } finally {
      this.running.delete(controller);
    }
  }
}
