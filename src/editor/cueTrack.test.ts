import { describe, expect, it } from "vitest";
import type { AudioQuery } from "../voice/timeline";
import { atOptions, decodeAt, encodeAt, isEmptyCue, nameOptions, phraseLabels, updateCue } from "./cueTrack";

describe("cue times", () => {
  it("round-trips through select values", () => {
    for (const at of ["start", "end", 1.5, { phrase: 2 }] as const) {
      expect(decodeAt(encodeAt(at), typeof at === "number" ? at : 0)).toEqual(at);
    }
    expect(decodeAt("s", -1)).toBe(0);
    expect(decodeAt("px", 0)).toEqual({ phrase: 0 });
  });

  it("labels phrases and keeps one the query doesn't have", () => {
    const query = {
      accent_phrases: [{ moras: [{ text: "コ" }, { text: "ン" }], accent: 1 }],
    } as unknown as AudioQuery;
    const labels = phraseLabels(query);
    expect(labels).toEqual(["コン"]);
    expect(atOptions(labels, { phrase: 2 }).map((o) => o.label)).toEqual([
      "start",
      "phrase 1: コン",
      "phrase 2",
      "phrase 3",
      "end",
      "seconds",
    ]);
  });
});

describe("cue editing", () => {
  it("merges model names after portable ones", () => {
    expect(nameOptions(["nod", "shake"], ["TapBody", "nod"])).toEqual(["nod", "shake", "TapBody"]);
  });

  it("patches one cue and drops cleared fields", () => {
    const cues = [{ at: "start" as const, gesture: "nod" }, { at: "end" as const, expression: "happy" }];
    const out = updateCue(cues, 0, { gesture: "", expression: "sad" });
    expect(out[0]).toEqual({ at: "start", expression: "sad" });
    expect(out[1]).toBe(cues[1]);
    expect(isEmptyCue({ at: "end" })).toBe(true);
    expect(isEmptyCue({ at: "end", lookAt: "camera" })).toBe(false);
  });
});
