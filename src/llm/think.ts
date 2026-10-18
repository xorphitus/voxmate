const OPEN = "<think>";
const CLOSE = "</think>";

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialTag(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(-n))) return n;
  }
  return 0;
}

/**
 * Removes `<think>...</think>` blocks that reasoning models (Qwen3,
 * DeepSeek-R1...) stream before the answer, so they are not read aloud.
 * Tags may be split across chunks; a possible partial tag is held back.
 */
export class ThinkFilter {
  private buf = "";
  private inside = false;

  /** Returns the text that is safe to speak so far. */
  push(text: string): string {
    this.buf += text;
    let out = "";
    for (;;) {
      if (this.inside) {
        const end = this.buf.indexOf(CLOSE);
        if (end < 0) {
          this.buf = this.buf.slice(this.buf.length - partialTag(this.buf, CLOSE));
          return out;
        }
        this.buf = this.buf.slice(end + CLOSE.length);
        this.inside = false;
      } else {
        const start = this.buf.indexOf(OPEN);
        if (start < 0) {
          const keep = partialTag(this.buf, OPEN);
          out += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + OPEN.length);
        this.inside = true;
      }
    }
  }

  /** Held-back text at the end of the stream; an unclosed block is dropped. */
  flush(): string {
    const rest = this.inside ? "" : this.buf;
    this.buf = "";
    this.inside = false;
    return rest;
  }
}
