import { describe, expect, it, vi } from "vitest";
import { SpeechQueue, type SpeechQueueDeps } from "./SpeechQueue";
import type { Utterance } from "./TextSource";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Records calls; play() waits until the test finishes the current playback. */
function harness() {
  const log: string[] = [];
  let finishPlay = deferred();
  const deps: SpeechQueueDeps<string> = {
    prepare: vi.fn(async (u: Utterance) => {
      log.push(`prepare:${u.text}`);
      if (u.text === "bad") throw new Error("synthesis failed");
      return `audio:${u.text}`;
    }),
    play: vi.fn(async (p: string) => {
      log.push(`play:${p}`);
      await finishPlay.promise;
      finishPlay = deferred();
    }),
    stop: vi.fn(() => finishPlay.resolve()),
    onError: vi.fn(),
  };
  return { log, deps, finish: () => finishPlay.resolve() };
}

describe("SpeechQueue", () => {
  it("plays utterances one at a time, in order", async () => {
    const h = harness();
    const q = new SpeechQueue(h.deps);
    q.enqueue({ text: "one" });
    q.enqueue({ text: "two" });
    await flush();
    expect(h.log.filter((l) => l.startsWith("play"))).toEqual(["play:audio:one"]);
    h.finish();
    await flush();
    expect(h.log.filter((l) => l.startsWith("play"))).toEqual(["play:audio:one", "play:audio:two"]);
  });

  it("prepares the next utterance while the current one plays", async () => {
    const h = harness();
    const q = new SpeechQueue(h.deps);
    q.enqueue({ text: "one" });
    q.enqueue({ text: "two" });
    await flush();
    expect(h.log).toEqual(["prepare:one", "prepare:two", "play:audio:one"]);
    h.finish();
    await flush();
    expect(h.deps.prepare).toHaveBeenCalledTimes(2);
  });

  it("ignores blank text and trims", async () => {
    const h = harness();
    const q = new SpeechQueue(h.deps);
    q.enqueue({ text: "   " });
    q.enqueue({ text: "  hi  " });
    await flush();
    expect(h.log).toEqual(["prepare:hi", "play:audio:hi"]);
  });

  it("reports errors and continues with the next utterance", async () => {
    const h = harness();
    const q = new SpeechQueue(h.deps);
    q.enqueue({ text: "bad" });
    q.enqueue({ text: "good" });
    await flush();
    expect(h.deps.onError).toHaveBeenCalledWith(expect.any(Error), { text: "bad" });
    expect(h.log).toContain("play:audio:good");
  });

  it("clear() stops playback and drops pending items", async () => {
    const h = harness();
    const q = new SpeechQueue(h.deps);
    q.enqueue({ text: "one" });
    q.enqueue({ text: "two" });
    await flush();
    q.clear();
    await flush();
    expect(h.deps.stop).toHaveBeenCalled();
    expect(h.log).not.toContain("play:audio:two");
    expect(q.pending).toBe(0);

    q.enqueue({ text: "three" });
    await flush();
    expect(h.log).toContain("play:audio:three");
  });

  it("drops an utterance whose synthesis finishes after clear()", async () => {
    const slow = deferred<string>();
    const play = vi.fn(async () => {});
    const q = new SpeechQueue<string>({ prepare: () => slow.promise, play, stop: () => {} });
    q.enqueue({ text: "late" });
    q.clear();
    slow.resolve("audio");
    await flush();
    expect(play).not.toHaveBeenCalled();
  });

  it("reports speaking state", async () => {
    const h = harness();
    const states: (string | null)[] = [];
    const q = new SpeechQueue({ ...h.deps, onStateChange: (s) => states.push(s.speaking?.text ?? null) });
    q.enqueue({ text: "one" });
    await flush();
    h.finish();
    await flush();
    expect(states).toContain("one");
    expect(states[states.length - 1]).toBeNull();
  });
});
