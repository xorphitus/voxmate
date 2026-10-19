import { describe, expect, it } from "vitest";
import { ConversationLog } from "./ConversationLog";
import type { Line, LineState } from "./Line";

const line = (text: string, extra: Partial<Line> = {}): Line => ({
  id: `id-${text}`,
  character: "zunda",
  text,
  source: "ui",
  ...extra,
});

describe("ConversationLog", () => {
  it("records lines once spoken, interrupted or not", () => {
    const log = new ConversationLog(() => 42);
    log.record({ line: line("done"), state: "done" });
    log.record({ line: line("cut", { sceneId: "s1" }), state: "interrupted" });
    expect(log.entries()).toEqual([
      { lineId: "id-done", character: "zunda", text: "done", source: "ui", time: 42 },
      { lineId: "id-cut", character: "zunda", text: "cut", source: "ui", time: 42, sceneId: "s1", interrupted: true },
    ]);
  });

  it("ignores lines that were never heard", () => {
    const log = new ConversationLog();
    for (const state of ["queued", "preparing", "speaking", "skipped", "failed"] as LineState[]) {
      log.record({ line: line(state), state });
    }
    expect(log.entries()).toEqual([]);
  });

  it("records stage directions", () => {
    const log = new ConversationLog(() => 0);
    log.record({ line: line("(Dinner.)", { direction: true }), state: "done" });
    expect(log.entries()[0]).toMatchObject({ text: "(Dinner.)", direction: true });
  });

  it("returns the most recent entries and keeps at most `max`", () => {
    const log = new ConversationLog(() => 0, 3);
    for (const text of ["a", "b", "c", "d"]) log.record({ line: line(text), state: "done" });
    expect(log.entries().map((e) => e.text)).toEqual(["b", "c", "d"]);
    expect(log.entries(2).map((e) => e.text)).toEqual(["c", "d"]);
    expect(log.entries(0)).toEqual([]);
  });
});
