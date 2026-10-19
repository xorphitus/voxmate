import { describe, expect, it, vi } from "vitest";
import type { LogEntry } from "./ConversationLog";
import type { Line, LineEvent, LineState } from "./Line";
import { addressed, nextSpeaker, Orchestrator, type OrchestratorState, type Participant } from "./Orchestrator";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const zunda = { id: "zunda", name: "ずんだもん" };
const metan = { id: "metan", name: "めたん" };
const tsumugi = { id: "tsumugi", name: "つむぎ" };

const entry = (character: string, text: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  lineId: text,
  character,
  text,
  source: "llm",
  time: 0,
  ...extra,
});

describe("addressed", () => {
  it("finds the first participant named, other than the speaker", () => {
    expect(addressed("めたん、ずんだもんはどう思う？", [zunda, metan], "metan")).toBe("zunda");
    expect(addressed("めたん、ずんだもんはどう思う？", [zunda, metan])).toBe("metan");
    expect(addressed("ねえ", [zunda, metan])).toBeUndefined();
  });
});

describe("nextSpeaker", () => {
  const all = [zunda, metan, tsumugi];

  it("goes round-robin", () => {
    expect(nextSpeaker([], all)).toBe("zunda");
    expect(nextSpeaker([entry("zunda", "やあ")], all)).toBe("metan");
    expect(nextSpeaker([entry("zunda", "a"), entry("tsumugi", "b")], all)).toBe("zunda");
  });

  it("prefers whoever the latest line names", () => {
    expect(nextSpeaker([entry("zunda", "つむぎはどう？")], all)).toBe("tsumugi");
    expect(nextSpeaker([entry("", "めたんに聞きたい", { user: true })], all)).toBe("metan");
  });

  it("skips stage directions and the user when going round-robin", () => {
    const log = [entry("metan", "a"), entry("", "(夕食の話)", { direction: true }), entry("", "で？", { user: true })];
    expect(nextSpeaker(log, all)).toBe("tsumugi");
  });
});

/** Fake stage: the test decides when lines are heard; `respond` answers at once unless `hold` is set. */
function setup(participants: Participant[] = [zunda, metan], replies?: (speaker: string, n: number) => string[]) {
  const listeners = new Set<(e: LineEvent) => void>();
  const log: LogEntry[] = [];
  const calls: { speaker: string; pending: string[]; signal: AbortSignal }[] = [];
  const skipped: string[] = [];
  const states: OrchestratorState[] = [];
  let id = 0;
  let clock = 0;
  let hold: Promise<void> | null = null;
  const queued: Line[] = [];

  const deps = {
    participants: () => participants,
    log: () => log,
    respond: vi.fn(async (speaker: string, signal: AbortSignal, pending: LogEntry[]) => {
      calls.push({ speaker, pending: pending.map((p) => p.text), signal });
      if (hold) await hold;
      if (signal.aborted) return [];
      const texts = replies ? replies(speaker, calls.length) : [`${speaker}${calls.length}`];
      const lines = texts.map((text) => ({ id: `l${++id}`, character: speaker, text, source: "llm" }));
      queued.push(...lines);
      return lines;
    }),
    onLineEvent: (l: (e: LineEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    skipQueued: (match: (line: Line) => boolean) => {
      // queued[0] stands for the line playing, which always finishes.
      for (const line of queued.slice(1).filter(match)) {
        skipped.push(line.id);
        emit(line, "skipped");
      }
    },
    direct: (text: string) => log.push(entry("", text, { direction: true })),
    onStateChange: (s: OrchestratorState) => states.push(s),
    now: () => clock,
  };
  const emit = (line: Line, state: LineState) => {
    const at = queued.indexOf(line);
    if ((state === "done" || state === "skipped") && at >= 0) queued.splice(at, 1);
    if (state === "done") log.push({ lineId: line.id, character: line.character, text: line.text, source: line.source, time: 0 });
    for (const l of listeners) l({ line, state });
  };
  /** Plays the oldest queued line to the end. */
  const hear = () => emit(queued[0], "done");
  const orchestrator = new Orchestrator(deps);
  return {
    orchestrator,
    calls,
    skipped,
    states,
    log,
    queued,
    hear,
    emit,
    speakers: () => calls.map((c) => c.speaker),
    setHold: (p: Promise<void> | null) => (hold = p),
    tick: (ms: number) => (clock += ms),
  };
}

describe("Orchestrator", () => {
  it("lets characters take turns until the turn limit", async () => {
    const h = setup();
    h.orchestrator.start({ maxTurns: 4, maxMinutes: 10 });
    for (let i = 0; i < 6; i++) {
      await flush();
      if (h.queued.length) h.hear();
    }
    await flush();
    expect(h.speakers()).toEqual(["zunda", "metan", "zunda", "metan"]);
    expect(h.orchestrator.current).toMatchObject({ running: false, turns: 4, stopReason: "max-turns" });
  });

  it("generates the next turn while the previous one plays, but stays at most one turn ahead", async () => {
    const h = setup();
    h.orchestrator.start({ maxTurns: 10, maxMinutes: 10 });
    await flush();
    // Turn 1 is queued, unheard; turn 2 was generated with it as pending context.
    expect(h.calls.map((c) => c.pending)).toEqual([[], ["zunda1"]]);
    await flush();
    expect(h.calls).toHaveLength(2);
    h.hear(); // turn 1 heard → turn 3 may start
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].pending).toEqual(["metan2"]);
    h.orchestrator.stop();
  });

  it("starts with the topic as a stage direction", async () => {
    const h = setup();
    h.orchestrator.start({ maxTurns: 1, maxMinutes: 10, topic: "夕食の献立" });
    await flush();
    expect(h.log[0]).toMatchObject({ text: "夕食の献立", direction: true });
  });

  it("ends the round when a turn says nothing", async () => {
    const h = setup(undefined, (speaker, n) => (n === 2 ? [] : [`${speaker}${n}`]));
    h.orchestrator.start({ maxTurns: 10, maxMinutes: 10 });
    await flush();
    expect(h.orchestrator.current).toMatchObject({ running: false, stopReason: "silent" });
  });

  it("stops after the time limit", async () => {
    const h = setup();
    h.orchestrator.start({ maxTurns: 10, maxMinutes: 1 });
    await flush();
    h.tick(60_000);
    h.hear();
    await flush();
    expect(h.orchestrator.current).toMatchObject({ running: false, stopReason: "max-minutes" });
  });

  it("needs two participants", async () => {
    const h = setup([zunda]);
    h.orchestrator.start({ maxTurns: 10, maxMinutes: 10 });
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.orchestrator.current.stopReason).toBe("no-participants");
  });

  it("drops the turn being generated when the user interjects, then answers", async () => {
    const h = setup([zunda, metan, tsumugi]);
    let release!: () => void;
    h.setHold(new Promise<void>((r) => (release = r)));
    h.orchestrator.start({ maxTurns: 10, maxMinutes: 10 });
    await flush();
    expect(h.calls).toHaveLength(1);
    h.log.push(entry("", "つむぎはどう思う？", { user: true }));
    h.orchestrator.interject();
    expect(h.calls[0].signal.aborted).toBe(true);
    h.setHold(null);
    release();
    await flush();
    expect(h.speakers().slice(0, 2)).toEqual(["zunda", "tsumugi"]);
    h.orchestrator.stop();
  });

  it("pauses for a script and resumes once it has played", async () => {
    const h = setup();
    h.orchestrator.start({ maxTurns: 10, maxMinutes: 10 });
    await flush();
    expect(h.calls).toHaveLength(2);
    const [, turn2] = h.queued;
    const script: Line = { id: "s1", character: "metan", text: "台本です", source: "api", sceneId: "scene" };
    h.emit(script, "queued");
    expect(h.skipped).toContain(turn2.id);
    expect(h.orchestrator.current.paused).toBe(true);
    h.hear(); // turn 1 finishes
    await flush();
    expect(h.calls).toHaveLength(2);
    h.emit(script, "done");
    await flush();
    expect(h.orchestrator.current.paused).toBe(false);
    // Turn 3 (and turn 4, one ahead) follow the script.
    expect(h.calls.length).toBeGreaterThanOrEqual(3);
    h.orchestrator.stop();
  });

  it("stops on demand", async () => {
    const h = setup();
    h.orchestrator.start({ maxTurns: 10, maxMinutes: 10 });
    await flush();
    h.orchestrator.stop();
    h.hear();
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.orchestrator.current).toMatchObject({ running: false, stopReason: "stopped" });
  });
});
