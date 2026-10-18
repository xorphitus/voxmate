/** Ends a sentence on its own. `.` only counts before whitespace (see push). */
const TERMINATORS = new Set(["。", "！", "？", "!", "?", "…", "\n"]);
/** Kept with the sentence they close, e.g. 「はい。」 */
const CLOSERS = new Set(["」", "』", "）", ")", '"', "”", "’"]);

/**
 * Cuts streamed LLM text into sentences so each can be spoken as soon as it
 * is complete. Japanese terminators end a sentence immediately; an ASCII `.`
 * only before whitespace, so "3.14" and "e.g" stay whole.
 */
export class SentenceSplitter {
  private buf = "";

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let start = 0;
    let i = 0;
    while (i < this.buf.length) {
      const ch = this.buf[i];
      let end = -1;
      if (TERMINATORS.has(ch)) {
        end = i + 1;
      } else if (ch === "." && i + 1 < this.buf.length && /\s/.test(this.buf[i + 1])) {
        end = i + 1;
      }
      if (end < 0) {
        i++;
        continue;
      }
      // Swallow repeated terminators and closing brackets ("！？", "。」").
      while (end < this.buf.length && (TERMINATORS.has(this.buf[end]) || CLOSERS.has(this.buf[end]))) end++;
      // A run that reaches the end of the buffer may continue in the next
      // chunk (a closing 」 or another ！), so wait for it or for flush().
      if (end === this.buf.length) break;
      const sentence = this.buf.slice(start, end).trim();
      if (sentence) out.push(sentence);
      start = end;
      i = end;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** The unterminated remainder, once the stream has ended. */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest || null;
  }
}
