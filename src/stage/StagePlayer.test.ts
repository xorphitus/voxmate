import { describe, expect, it, vi } from "vitest";
import type { Line, LineDraft, LineEvent } from "./Line";
import { StagePlayer, type StagePlayerDeps } from "./StagePlayer";

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

const draft = (text: string, extra: Partial<LineDraft> = {}): LineDraft => ({ text, source: "test", ...extra });

/** Records calls and events; play() waits until the test finishes the current playback. */
function harness(overrides: Partial<StagePlayerDeps<string>> = {}) {
  const log: string[] = [];
  let finishPlay = deferred();
  let id = 0;
  const deps: StagePlayerDeps<string> = {
    prepare: vi.fn(async (line: Line) => {
      log.push(`prepare:${line.text}`);
      if (line.text === "bad") throw new Error("synthesis failed");
      return `audio:${line.text}`;
    }),
    play: vi.fn(async (p: string) => {
      log.push(`play:${p}`);
      await finishPlay.promise;
      finishPlay = deferred();
    }),
    stop: vi.fn(() => finishPlay.resolve()),
    defaultCharacter: () => "zunda",
    newId: () => `id${++id}`,
    ...overrides,
  };
  const q = new StagePlayer(deps);
  const events: LineEvent[] = [];
  q.subscribe((e) => events.push(e));
  /** "text:state" for every event so far. */
  const states = () => events.map((e) => `${e.line.text}:${e.state}`);
  const played = () => log.filter((l) => l.startsWith("play")).map((l) => l.slice("play:audio:".length));
  return { q, log, deps, events, states, played, finish: () => finishPlay.resolve() };
}

describe("StagePlayer", () => {
  it("plays lines one at a time, in order", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    h.q.enqueue(draft("two"));
    await flush();
    expect(h.played()).toEqual(["one"]);
    h.finish();
    await flush();
    expect(h.played()).toEqual(["one", "two"]);
  });

  it("prepares the next line while the current one plays", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    h.q.enqueue(draft("two"));
    await flush();
    expect(h.log).toEqual(["prepare:one", "prepare:two", "play:audio:one"]);
    h.finish();
    await flush();
    expect(h.deps.prepare).toHaveBeenCalledTimes(2);
  });

  it("assigns ids and the default character, and trims", () => {
    const h = harness();
    expect(h.q.enqueue(draft("  hi  "))).toEqual({ id: "id1", character: "zunda", text: "hi", source: "test" });
    expect(h.q.enqueue(draft("yo", { id: "mine", character: "metan" }))).toMatchObject({
      id: "mine",
      character: "metan",
    });
  });

  it("ignores blank text", async () => {
    const h = harness();
    expect(h.q.enqueue(draft("   "))).toBeNull();
    await flush();
    expect(h.log).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("reports each line's lifecycle", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    await flush();
    h.finish();
    await flush();
    expect(h.states()).toEqual(["one:queued", "one:preparing", "one:speaking", "one:done"]);
  });

  it("reports failures and continues with the next line", async () => {
    const h = harness();
    h.q.enqueue(draft("bad"));
    h.q.enqueue(draft("good"));
    await flush();
    const failed = h.events.find((e) => e.state === "failed");
    expect(failed).toMatchObject({ line: { text: "bad" }, error: new Error("synthesis failed") });
    expect(h.played()).toEqual(["good"]);
  });

  it("reports a playback error as failed", async () => {
    const h = harness({ play: async () => Promise.reject(new Error("suspended")) });
    h.q.enqueue(draft("one"));
    await flush();
    expect(h.states()).toContain("one:failed");
  });

  it("clear() interrupts the current line and skips the queued ones", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    h.q.enqueue(draft("two"));
    await flush();
    h.q.clear();
    await flush();
    expect(h.deps.stop).toHaveBeenCalled();
    expect(h.states()).toContain("one:interrupted");
    expect(h.states()).toContain("two:skipped");
    expect(h.played()).toEqual(["one"]);
    expect(h.q.pending).toBe(0);

    h.q.enqueue(draft("three"));
    await flush();
    expect(h.played()).toEqual(["one", "three"]);
  });

  it("drops a line whose synthesis finishes after clear()", async () => {
    const slow = deferred<string>();
    const h = harness({ prepare: () => slow.promise });
    h.q.enqueue(draft("late"));
    await flush();
    h.q.clear();
    slow.resolve("audio");
    await flush();
    expect(h.deps.play).not.toHaveBeenCalled();
    expect(h.states()).toEqual(["late:queued", "late:preparing", "late:skipped"]);
  });

  it("does not report a failure for a line dropped while it was being prepared", async () => {
    const slow = deferred<string>();
    const h = harness({ prepare: () => slow.promise });
    h.q.enqueue(draft("late"));
    await flush();
    h.q.clear();
    slow.reject(new Error("aborted"));
    await flush();
    expect(h.states()).not.toContain("late:failed");
  });

  it("skip() interrupts only the current line", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    h.q.enqueue(draft("two"));
    await flush();
    h.q.skip();
    await flush();
    expect(h.states()).toContain("one:interrupted");
    expect(h.played()).toEqual(["one", "two"]);
  });

  it("exposes the current line and the queue length", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    h.q.enqueue(draft("two"));
    await flush();
    expect(h.q.current?.text).toBe("one");
    expect(h.q.pending).toBe(1);
    h.finish();
    await flush();
    h.finish();
    await flush();
    expect(h.q.current).toBeNull();
  });

  it("queues the lines of a scene together under one scene id", async () => {
    const h = harness();
    const lines = h.q.enqueueScene({
      id: "s1",
      source: "api",
      lines: [{ text: "a", character: "metan" }, { text: " " }, { text: "b" }],
    });
    expect(lines.map((l) => [l.text, l.character, l.sceneId, l.source])).toEqual([
      ["a", "metan", "s1", "api"],
      ["b", "zunda", "s1", "api"],
    ]);
  });

  it("inserts 'next' lines after the rest of the current scene", async () => {
    const h = harness();
    h.q.enqueueScene({ id: "s1", source: "test", lines: [{ text: "s1a" }, { text: "s1b" }] });
    h.q.enqueue(draft("later"));
    await flush();
    h.q.enqueueScene({ id: "s2", source: "test", lines: [{ text: "s2a" }] }, "next");
    for (let i = 0; i < 4; i++) {
      h.finish();
      await flush();
    }
    expect(h.played()).toEqual(["s1a", "s1b", "s2a", "later"]);
  });

  it("inserts 'next' lines right after a line outside any scene, and prepares them ahead", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    h.q.enqueue(draft("later"));
    await flush();
    h.q.enqueue(draft("urgent"), "next");
    await flush();
    expect(h.log).toContain("prepare:urgent");
    h.finish();
    await flush();
    expect(h.played()).toEqual(["one", "urgent"]);
  });

  it("cancelScene() drops a scene and interrupts it if it is speaking", async () => {
    const h = harness();
    h.q.enqueueScene({ id: "s1", source: "test", lines: [{ text: "s1a" }, { text: "s1b" }] });
    h.q.enqueue(draft("other"));
    await flush();
    h.q.cancelScene("s1");
    await flush();
    expect(h.states()).toContain("s1a:interrupted");
    expect(h.states()).toContain("s1b:skipped");
    expect(h.played()).toEqual(["s1a", "other"]);
  });

  it("cancelScene() leaves the current line alone when it belongs to another scene", async () => {
    const h = harness();
    h.q.enqueue(draft("one"));
    h.q.enqueueScene({ id: "s1", source: "test", lines: [{ text: "s1a" }] });
    await flush();
    h.q.cancelScene("s1");
    await flush();
    expect(h.deps.stop).not.toHaveBeenCalled();
    expect(h.states()).toContain("s1a:skipped");
  });

  it("passes stage directions through without speaking them", async () => {
    const h = harness();
    h.q.enqueue(draft("(The topic changes.)", { direction: true }));
    h.q.enqueue(draft("one"));
    await flush();
    expect(h.deps.prepare).toHaveBeenCalledTimes(1);
    expect(h.states().filter((s) => s.startsWith("("))).toEqual(["(The topic changes.):queued", "(The topic changes.):done"]);
    expect(h.played()).toEqual(["one"]);
  });

  it("keeps going when a listener throws", async () => {
    const h = harness();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.q.subscribe(() => {
      throw new Error("listener");
    });
    h.q.enqueue(draft("one"));
    await flush();
    expect(h.played()).toEqual(["one"]);
    error.mockRestore();
  });
});
