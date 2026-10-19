import { describe, expect, it } from "vitest";
import { cueInstruction, extractCueTags } from "./cueTags";

const vocabulary = { expressions: ["neutral", "happy", "sad"], gestures: ["nod", "shake"] };

describe("extractCueTags", () => {
  it("turns known tags into cues and removes them from the text", () => {
    expect(extractCueTags("[happy]やったのだ！[nod]", vocabulary)).toEqual({
      text: "やったのだ！",
      cues: [
        { at: "start", expression: "happy" },
        { at: "end", gesture: "nod" },
      ],
    });
  });

  it("fires a tag in the middle at the start", () => {
    expect(extractCueTags("えっと[shake]違うのだ。", vocabulary).cues).toEqual([{ at: "start", gesture: "shake" }]);
  });

  it("leaves other brackets alone", () => {
    expect(extractCueTags("[注] 本日は[晴れ]です", vocabulary)).toEqual({ text: "[注] 本日は[晴れ]です", cues: [] });
  });

  it("returns empty text for a sentence of tags", () => {
    expect(extractCueTags("[sad] [nod]", vocabulary)).toEqual({
      text: "",
      cues: [
        { at: "end", expression: "sad" },
        { at: "end", gesture: "nod" },
      ],
    });
  });
});

describe("cueInstruction", () => {
  it("lists the tags, leaving out neutral", () => {
    expect(cueInstruction(vocabulary)).toContain("Available: [happy] [sad] [nod] [shake]");
    expect(cueInstruction({ expressions: [], gestures: [] })).toBe("");
  });
});
