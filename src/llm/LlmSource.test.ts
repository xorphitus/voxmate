import { describe, expect, it, vi } from "vitest";
import type { LineDraft } from "../stage/Line";
import type { ChatMessage, LlmProvider } from "./LlmProvider";
import { LlmSource } from "./LlmSource";

/** Streams the given replies in order, one per chat() call, and records the requests. */
function fakeProvider(replies: string[][]) {
  const requests: ChatMessage[][] = [];
  const provider: LlmProvider = {
    async *chat(messages, signal) {
      requests.push(messages);
      for (const chunk of replies.shift() ?? []) {
        await Promise.resolve();
        if (signal.aborted) return;
        yield chunk;
      }
    },
  };
  return { provider, requests };
}

function setup(replies: string[][], history = 10, systemPrompt = "") {
  const { provider, requests } = fakeProvider(replies);
  const onError = vi.fn();
  const source = new LlmSource(provider, () => ({ systemPrompt, history }), onError);
  const said: LineDraft[] = [];
  source.start((u) => (said.push(u), null));
  return { source, said, requests, onError };
}

describe("LlmSource", () => {
  it("speaks each sentence of the streamed reply", async () => {
    const { source, said } = setup([["こんにちは。", "元気", "なのだ"]]);
    await source.ask("やあ");
    expect(said).toEqual([
      { text: "こんにちは。", source: "llm" },
      { text: "元気なのだ", source: "llm" },
    ]);
  });

  it("neither speaks nor remembers think blocks", async () => {
    const { source, said, requests } = setup([["<think>hmm", "</think>はい。"], ["b。"]]);
    await source.ask("q1");
    await source.ask("q2");
    expect(said.map((u) => u.text)).toEqual(["はい。", "b。"]);
    expect(requests[1][1]).toEqual({ role: "assistant", content: "はい。" });
  });

  it("sends the system prompt and past turns", async () => {
    const { source, requests } = setup([["一。"], ["二。"]], 10, "short answers");
    await source.ask("q1");
    await source.ask("q2");
    expect(requests[1]).toEqual([
      { role: "system", content: "short answers" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "一。" },
      { role: "user", content: "q2" },
    ]);
  });

  it("keeps only the configured number of past messages", async () => {
    const { source, requests } = setup([["a。"], ["b。"], ["c。"]], 2);
    await source.ask("1");
    await source.ask("2");
    await source.ask("3");
    expect(requests[2].map((m) => m.content)).toEqual(["2", "b。", "3"]);
  });

  it("sends no history when it is 0", async () => {
    const { source, requests } = setup([["a。"], ["b。"]], 0);
    await source.ask("1");
    await source.ask("2");
    expect(requests[1]).toEqual([{ role: "user", content: "2" }]);
  });

  it("stops speaking once cancelled", async () => {
    const { source, said, onError } = setup([["一。", "二。", "三。"]]);
    const done = source.ask("q");
    await Promise.resolve();
    await Promise.resolve();
    source.cancel();
    await done;
    expect(said.length).toBeLessThan(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports provider errors", async () => {
    const provider: LlmProvider = {
      async *chat() {
        throw new Error("boom");
      },
    };
    const onError = vi.fn();
    const source = new LlmSource(provider, () => ({ systemPrompt: "", history: 10 }), onError);
    source.start(() => null);
    await source.ask("q");
    expect(onError).toHaveBeenCalledWith(new Error("boom"));
  });
});

describe("LlmSource character", () => {
  it("tags each sentence with the character who answers", async () => {
    const { provider } = fakeProvider([["はい。"]]);
    const source = new LlmSource(provider, () => ({ systemPrompt: "", history: 0, character: "zunda" }), vi.fn());
    const said: LineDraft[] = [];
    source.start((u) => (said.push(u), null));
    await source.ask("やあ");
    expect(said).toEqual([{ text: "はい。", character: "zunda", source: "llm" }]);
  });
});
