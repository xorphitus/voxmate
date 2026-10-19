import { describe, expect, it } from "vitest";
import type { LogEntry } from "../stage/ConversationLog";
import { buildContext, stripOwnName } from "./context";

const entry = (character: string, text: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  lineId: text,
  character,
  text,
  source: "test",
  time: 0,
  ...extra,
});

const self = { id: "zunda", name: "ずんだもん", persona: "語尾はなのだ" };
const nameOf = (id: string) => ({ metan: "めたん" })[id] ?? id;

describe("buildContext", () => {
  it("maps the log to roles from the character's point of view", () => {
    const log = [
      entry("", "こんにちは", { user: true }),
      entry("metan", "ごきげんよう"),
      entry("zunda", "やあ。"),
      entry("zunda", "元気なのだ。"),
      entry("", "話題は夕食に移る", { direction: true }),
    ];
    expect(buildContext(log, self, nameOf, 10)).toEqual([
      {
        role: "system",
        content:
          "語尾はなのだ\n\nYou are ずんだもん. Lines from other characters start with their name and a colon; answer without one.",
      },
      { role: "user", content: "こんにちは\nめたん: ごきげんよう" },
      { role: "assistant", content: "やあ。\n元気なのだ。" },
      { role: "user", content: "[Stage direction] 話題は夕食に移る" },
    ]);
  });

  it("keeps only the most recent entries", () => {
    const log = [entry("metan", "1"), entry("zunda", "2"), entry("metan", "3")];
    expect(buildContext(log, self, nameOf, 2).slice(1)).toEqual([
      { role: "assistant", content: "2" },
      { role: "user", content: "めたん: 3" },
    ]);
    expect(buildContext(log, self, nameOf, 0)).toHaveLength(1);
  });

  it("never merges into the system prompt", () => {
    expect(buildContext([], { ...self, persona: "" }, nameOf, 10)).toEqual([
      { role: "system", content: expect.stringContaining("You are ずんだもん.") },
    ]);
  });
});

describe("stripOwnName", () => {
  it("drops a leading name prefix", () => {
    expect(stripOwnName("ずんだもん: やあ", "ずんだもん")).toBe("やあ");
    expect(stripOwnName("ずんだもん：やあ", "ずんだもん")).toBe("やあ");
    expect(stripOwnName("やあ", "ずんだもん")).toBe("やあ");
  });
});
