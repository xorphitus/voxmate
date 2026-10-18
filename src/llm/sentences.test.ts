import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./sentences";

function split(chunks: string[]): string[] {
  const s = new SentenceSplitter();
  const out = chunks.flatMap((c) => s.push(c));
  const rest = s.flush();
  return rest ? [...out, rest] : out;
}

describe("SentenceSplitter", () => {
  it("emits Japanese sentences as soon as the next text arrives", () => {
    const s = new SentenceSplitter();
    expect(s.push("こんにちは。元")).toEqual(["こんにちは。"]);
    expect(s.push("気ですか？")).toEqual([]);
    expect(s.flush()).toBe("元気ですか？");
  });

  it("reassembles sentences split across chunks", () => {
    expect(split(["ずん", "だもん", "なのだ", "。次"])).toEqual(["ずんだもんなのだ。", "次"]);
  });

  it("keeps closing brackets and repeated terminators with the sentence", () => {
    expect(split(["「はい。", "」そう", "です！？", "本当"])).toEqual(["「はい。」", "そうです！？", "本当"]);
  });

  it("splits English on a period only before whitespace", () => {
    expect(split(["Pi is 3.14. It is ", "irrational."])).toEqual(["Pi is 3.14.", "It is irrational."]);
  });

  it("splits on newlines and drops blank lines", () => {
    expect(split(["一行目\n\n二行目"])).toEqual(["一行目", "二行目"]);
  });

  it("returns null from flush when nothing is left", () => {
    const s = new SentenceSplitter();
    s.push("終わり。 ");
    expect(s.flush()).toBeNull();
  });
});
