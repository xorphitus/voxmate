import type { TextSource, LineSink } from "../speech/TextSource";
import type { ChatMessage, LlmProvider } from "./LlmProvider";
import { SentenceSplitter } from "./sentences";
import { ThinkFilter } from "./think";

export interface LlmSourceOptions {
  systemPrompt: string;
  /** How many past messages (user + assistant) to send along; 0 forgets everything. */
  history: number;
  /** Who speaks the reply; omitted means the character on stage. */
  character?: string;
}

/**
 * Turns questions into spoken replies. Each sentence is pushed to the sink as
 * soon as it is complete, so speech starts before the reply has finished.
 */
export class LlmSource implements TextSource {
  readonly name = "llm";
  private sink: LineSink | null = null;
  private history: ChatMessage[] = [];
  private controller: AbortController | null = null;

  constructor(
    private readonly provider: LlmProvider,
    private readonly options: () => LlmSourceOptions,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(sink: LineSink): void {
    this.sink = sink;
  }

  stop(): void {
    this.cancel();
    this.sink = null;
  }

  /** Abandon the reply being generated; the part received so far stays in the history. */
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  async ask(question: string): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const { systemPrompt, history, character } = this.options();
    const messages: ChatMessage[] = [
      ...(systemPrompt.trim() ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...this.recent(history),
      { role: "user", content: question },
    ];

    const think = new ThinkFilter();
    const splitter = new SentenceSplitter();
    // Only the spoken part is kept, so reasoning does not fill the context.
    let reply = "";
    const say = (text: string) => {
      if (!signal.aborted) this.sink?.({ text, ...(character && { character }), source: this.name });
    };
    const feed = (text: string) => {
      reply += text;
      splitter.push(text).forEach(say);
    };
    try {
      for await (const delta of this.provider.chat(messages, signal)) feed(think.push(delta));
      feed(think.flush());
      const rest = splitter.flush();
      if (rest) say(rest);
    } catch (e) {
      if (!signal.aborted) this.onError(e);
    } finally {
      if (reply.trim()) {
        this.history.push({ role: "user", content: question }, { role: "assistant", content: reply });
        this.history = this.recent(history);
      }
      if (this.controller === controller) this.controller = null;
    }
  }

  private recent(count: number): ChatMessage[] {
    // slice(-0) would return everything.
    return count > 0 ? this.history.slice(-count) : [];
  }
}
