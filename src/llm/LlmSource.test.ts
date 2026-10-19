import { describe, expect, it, vi } from "vitest";
import { ConversationLog } from "../stage/ConversationLog";
import type { LineDraft } from "../stage/Line";
import type { AgentCharacter } from "./context";
import { LlmAgent } from "./LlmAgent";
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

const zunda: AgentCharacter = { id: "zunda", name: "ずんだもん", persona: "語尾はなのだ" };
const metan: AgentCharacter = { id: "metan", name: "めたん", persona: "お嬢様口調" };

/** Every line the sink receives is "heard" at once, so it lands in the log. */
function setup(replies: string[][], history = 20, provider = fakeProvider(replies)) {
  const log = new ConversationLog(() => 0);
  const characters = { zunda, metan };
  const onError = vi.fn();
  const source = new LlmSource({
    agent: (id = "zunda") =>
      new LlmAgent({
        character: characters[id as keyof typeof characters],
        provider: provider.provider,
        nameOf: (c) => characters[c as keyof typeof characters]?.name ?? c,
        history,
        source: "llm",
      }),
    log,
    onError,
  });
  const said: LineDraft[] = [];
  let n = 0;
  source.start((draft) => {
    said.push(draft);
    const line = { ...draft, id: `l${++n}`, character: draft.character ?? "zunda" };
    log.record({ line, state: "done" });
    return line;
  });
  return { source, said, log, requests: provider.requests, onError };
}

describe("LlmSource", () => {
  it("speaks each sentence of the streamed reply as the character", async () => {
    const { source, said } = setup([["こんにちは。", "元気", "なのだ"]]);
    await source.ask("やあ");
    expect(said).toEqual([
      { text: "こんにちは。", character: "zunda", source: "llm" },
      { text: "元気なのだ", character: "zunda", source: "llm" },
    ]);
  });

  it("logs the question and answers from the log", async () => {
    const { source, requests, log } = setup([["一。"], ["二。"]]);
    await source.ask("q1");
    await source.ask("q2");
    expect(log.entries().map((e) => e.text)).toEqual(["q1", "一。", "q2", "二。"]);
    expect(requests[1].slice(1)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "一。" },
      { role: "user", content: "q2" },
    ]);
  });

  it("neither speaks nor remembers think blocks", async () => {
    const { source, said, requests } = setup([["<think>hmm", "</think>はい。"], ["b。"]]);
    await source.ask("q1");
    await source.ask("q2");
    expect(said.map((u) => u.text)).toEqual(["はい。", "b。"]);
    expect(requests[1][2]).toEqual({ role: "assistant", content: "はい。" });
  });

  it("lets each character answer in its own persona, knowing what the other said", async () => {
    const { source, requests } = setup([["僕はずんだもんなのだ。"], ["わたくしはめたんですわ。"]]);
    await source.ask("自己紹介して");
    await source.respond("metan");
    expect(requests[1][0].content).toContain("お嬢様口調");
    expect(requests[1][0].content).toContain("You are めたん.");
    expect(requests[1].slice(1)).toEqual([
      { role: "user", content: "自己紹介して\nずんだもん: 僕はずんだもんなのだ。" },
    ]);
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

  it("runs replies of several characters at once, cancelling them all", async () => {
    const { source, said } = setup([["あ。", "い。", "う。"], ["か。", "き。", "く。"]]);
    const a = source.respond("zunda");
    const b = source.respond("metan");
    await Promise.resolve();
    await Promise.resolve();
    source.cancel();
    await Promise.all([a, b]);
    expect(said.length).toBeLessThan(6);
  });

  it("reports provider errors", async () => {
    const provider: LlmProvider = {
      async *chat() {
        throw new Error("boom");
      },
    };
    const { source, onError } = setup([], 20, { provider, requests: [] });
    await source.ask("q");
    expect(onError).toHaveBeenCalledWith(new Error("boom"));
  });
});

describe("LlmSource.respond", () => {
  it("returns the queued lines and sees lines that are queued but not heard yet", async () => {
    const { source, requests } = setup([["はい。"]]);
    const pending = [{ lineId: "p1", character: "metan", text: "まだ再生中ですわ", source: "llm", time: 0 }];
    const lines = await source.respond("zunda", { pending });
    expect(lines.map((l) => [l.text, l.character])).toEqual([["はい。", "zunda"]]);
    expect(requests[0].slice(1)).toEqual([{ role: "user", content: "めたん: まだ再生中ですわ" }]);
  });

  it("stops when the caller's signal aborts", async () => {
    const { source, said, onError } = setup([["一。", "二。", "三。"]]);
    const controller = new AbortController();
    const done = source.respond("zunda", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await done;
    expect(said.length).toBeLessThan(3);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("LlmAgent cue tags", () => {
  it("acts out tags instead of speaking them, and tells the model which exist", async () => {
    const { provider, requests } = fakeProvider([["[happy]やった", "のだ！", "[nod]", "うん。"]]);
    const agent = new LlmAgent({
      character: { ...zunda, cues: { expressions: ["neutral", "happy"], gestures: ["nod"] } },
      provider,
      nameOf: (id) => id,
      history: 10,
      source: "llm",
    });
    const lines: LineDraft[] = [];
    for await (const l of agent.respond([], new AbortController().signal)) lines.push(l);
    expect(lines).toEqual([
      { text: "やったのだ！", character: "zunda", source: "llm", cues: [{ at: "start", expression: "happy" }] },
      { text: "うん。", character: "zunda", source: "llm", cues: [{ at: "start", gesture: "nod" }] },
    ]);
    expect(requests[0][0].content).toContain("Available: [happy] [nod]");
  });
});
