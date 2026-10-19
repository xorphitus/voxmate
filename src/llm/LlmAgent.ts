import type { Cue } from "../avatar/cues";
import type { LogEntry } from "../stage/ConversationLog";
import type { LineDraft } from "../stage/Line";
import { type AgentCharacter, buildContext, stripOwnName } from "./context";
import { extractCueTags } from "./cueTags";
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
 * and yields each sentence as a line as soon as it is complete. Cue tags in
 * the reply (`[happy]`) become the line's cues instead of being spoken.
 */
export class LlmAgent {
  constructor(private readonly options: LlmAgentOptions) {}

  async *respond(log: LogEntry[], signal: AbortSignal): AsyncIterable<LineDraft> {
    const { character, provider, nameOf, history, source } = this.options;
    const messages = buildContext(log, character, nameOf, history);
    const think = new ThinkFilter();
    const splitter = new SentenceSplitter();
    let first = true;
    /** Cues from a sentence that was only tags; they open the next line. */
    let carried: Cue[] = [];
    const line = (sentence: string): LineDraft | null => {
      if (first) sentence = stripOwnName(sentence, character.name);
      first = false;
      const { text, cues } = character.cues ? extractCueTags(sentence, character.cues) : { text: sentence, cues: [] };
      if (!text.trim()) {
        carried.push(...cues.map((c) => ({ ...c, at: "start" as const })));
        return null;
      }
      const all = [...carried, ...cues];
      carried = [];
      return { text, character: character.id, source, ...(all.length && { cues: all }) };
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
