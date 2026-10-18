import { describe, expect, it } from "vitest";
import { ThinkFilter } from "./think";

function run(chunks: string[]): string {
  const f = new ThinkFilter();
  return chunks.map((c) => f.push(c)).join("") + f.flush();
}

describe("ThinkFilter", () => {
  it("passes text without think blocks through unchanged", () => {
    expect(run(["こんにちは。", "元気？"])).toBe("こんにちは。元気？");
  });

  it("removes a think block before the answer", () => {
    expect(run(["<think>\nThe user greets me.\n</think>\n\nこんにちは。"])).toBe("\n\nこんにちは。");
  });

  it("handles tags split across chunks", () => {
    expect(run(["<th", "ink>reason", "ing</thi", "nk>答え"])).toBe("答え");
  });

  it("does not hold back text that only looks like the start of a tag", () => {
    const f = new ThinkFilter();
    expect(f.push("a < b")).toBe("a < b");
    expect(f.push(" <t")).toBe(" ");
    expect(f.push("ag>")).toBe("<tag>");
  });

  it("drops an unclosed think block at the end", () => {
    expect(run(["答え。<think>まだ考え中"])).toBe("答え。");
  });
});
