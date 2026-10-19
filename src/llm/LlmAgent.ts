import type { LogEntry } from "../stage/ConversationLog";
import type { LineDraft } from "../stage/Line";
import { type AgentCharacter, buildContext, stripOwnName } from "./context";
import type { LlmProvider } from "./LlmProvider";
import { SentenceSplitter } from "./sentences";
import { ThinkFilter } from "./think";

export interface LlmAgentOptions {
  character: AgentCharacter;
  provider: LlmProvider;
  /** Display name for a character id, for other characters' lines. */
  nameOf(characterId: string): string;
  /** How many recent log entries to send along. */
  history: number;
  source: string;
}

/**
 * One character's LLM persona. It answers from the shared conversation log
 * and yields each sentence as a line as soon as it is complete.
 */
export class LlmAgent {
  constructor(private readonly options: LlmAgentOptions) {}

  async *respond(log: LogEntry[], signal: AbortSignal): AsyncIterable<LineDraft> {
    const { character, provider, nameOf, history, source } = this.options;
    const messages = buildContext(log, character, nameOf, history);
    const think = new ThinkFilter();
    const splitter = new SentenceSplitter();
    let first = true;
    const line = (text: string): LineDraft | null => {
      if (first) text = stripOwnName(text, character.name);
      first = false;
      return text.trim() ? { text, character: character.id, source } : null;
    };

    for await (const delta of provider.chat(messages, signal)) {
      for (const sentence of splitter.push(think.push(delta))) {
        const l = line(sentence);
        if (l) yield l;
      }
    }
    const tail = [...splitter.push(think.flush()), splitter.flush()];
    for (const sentence of tail) {
      const l = sentence ? line(sentence) : null;
      if (l) yield l;
    }
  }
}
