import type { Cue } from "../avatar/cues";

export interface CueVocabulary {
  expressions: string[];
  gestures: string[];
}

/**
 * Pulls inline cue tags such as `[happy]` or `[nod]` out of one sentence of
 * an LLM reply. Only names in `vocabulary` count, so other brackets stay in
 * the text. A tag after all of the spoken text fires at the end of the line;
 * any other tag fires at the start.
 */
export function extractCueTags(sentence: string, vocabulary: CueVocabulary): { text: string; cues: Cue[] } {
  const expressions = new Set(vocabulary.expressions);
  const gestures = new Set(vocabulary.gestures);
  const cues: Cue[] = [];
  const text = sentence.replace(/\[([^\[\]\s]{1,64})\]/g, (tag, name: string, offset: number) => {
    const isExpression = expressions.has(name);
    if (!isExpression && !gestures.has(name)) return tag;
    const rest = sentence.slice(offset + tag.length).replace(/\[[^\[\]\s]{1,64}\]/g, "");
    const at = rest.trim() ? "start" : "end";
    cues.push(isExpression ? { at, expression: name } : { at, gesture: name });
    return "";
  });
  return { text: text.replace(/\s{2,}/g, " ").trim(), cues };
}

/** The prompt line that tells a character which tags it may write. */
export function cueInstruction({ expressions, gestures }: CueVocabulary): string {
  const tags = [...expressions.filter((e) => e !== "neutral"), ...gestures].map((n) => `[${n}]`);
  return tags.length
    ? `You may show feelings and gestures by writing tags in your reply, e.g. "[happy]こんにちは！". They are acted out, not spoken. Available: ${tags.join(" ")}`
    : "";
}
