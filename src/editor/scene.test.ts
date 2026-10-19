import { describe, expect, it } from "vitest";
import {
  blankLine,
  exportLines,
  type EditorLine,
  fromSceneFile,
  insertLine,
  moveLine,
  removeLine,
  startGesture,
  toSceneFile,
  withStartGesture,
} from "./scene";

const line = (text: string, extra: Partial<EditorLine> = {}): EditorLine => ({
  key: text,
  character: "zunda",
  text,
  voice: {},
  ...extra,
});

describe("line operations", () => {
  it("inserts, moves and removes", () => {
    let lines = [line("a"), line("b")];
    lines = insertLine(lines, 1, line("x"));
    expect(lines.map((l) => l.text)).toEqual(["a", "x", "b"]);
    expect(moveLine(lines, 0, 1).map((l) => l.text)).toEqual(["x", "a", "b"]);
    expect(moveLine(lines, 0, -1)).toBe(lines);
    expect(removeLine(lines, 1).map((l) => l.text)).toEqual(["a", "b"]);
    expect(blankLine("metan")).toMatchObject({ character: "metan", text: "", voice: {} });
  });

  it("edits the start gesture without touching other cues", () => {
    const l = line("a", { cues: [{ at: "end", expression: "happy" }] });
    const nodding = withStartGesture(l, "nod");
    expect(startGesture(nodding)).toBe("nod");
    expect(nodding.cues).toEqual([
      { at: "start", gesture: "nod" },
      { at: "end", expression: "happy" },
    ]);
    expect(withStartGesture(nodding, "").cues).toEqual([{ at: "end", expression: "happy" }]);
    expect(withStartGesture(line("b"), "").cues).toBeUndefined();
  });
});

describe("scene files", () => {
  it("saves in the scene API's format, leaving out blank lines and empty fields", () => {
    const file = toSceneFile([
      line(" こんにちは ", { voice: { speed: 1.2, pitch: 9 }, emotion: "happy" }),
      line("  "),
      line("(夕食の話)", { character: "metan", direction: true }),
    ]);
    expect(file).toEqual({
      lines: [
        { character: "zunda", text: "こんにちは", voice: { speed: 1.2 }, emotion: "happy" },
        { character: "metan", text: "(夕食の話)", direction: true },
      ],
    });
  });

  it("round-trips", () => {
    const lines = [
      line("a", { voice: { intonation: 1.5 }, cues: [{ at: { phrase: 1 }, gesture: "nod" }] }),
      line("b", { character: "metan", audioQuery: { accent_phrases: [] } as never, speaker: 2 }),
    ];
    const back = fromSceneFile(JSON.parse(JSON.stringify(toSceneFile(lines))), "zunda");
    expect(back.map(({ key: _, ...rest }) => rest)).toEqual(lines.map(({ key: _, ...rest }) => rest));
  });

  it("fills in the character and rejects other JSON", () => {
    expect(fromSceneFile({ lines: [{ text: "hi" }] }, "metan")[0].character).toBe("metan");
    expect(() => fromSceneFile({ text: "hi" }, "z")).toThrow(/not a scene file/);
    expect(() => fromSceneFile({ lines: [{ character: "z" }] }, "z")).toThrow(/lines\[0\] has no text/);
  });
});

describe("exportLines", () => {
  const characters = [
    { id: "zunda", name: "Z", modelPath: null, speaker: 3, persona: "", llmModel: "", voice: { speed: 1.2 }, names: {} },
  ];

  it("resolves speaker and voice like the stage, skipping directions and blanks", () => {
    const lines = [
      line("やあ", { voice: { pitch: 0.1 } }),
      line("(間)", { direction: true }),
      line(" "),
      line("q", { speaker: 8, audioQuery: { accent_phrases: [] } as never }),
    ];
    expect(exportLines(lines, characters)).toEqual([
      { text: "やあ", speaker: 3, voice: { speed: 1.2, pitch: 0.1 } },
      { text: "q", speaker: 8, voice: {}, query: { accent_phrases: [] } },
    ]);
  });

  it("names an unknown character", () => {
    expect(() => exportLines([line("a", { character: "ghost" })], characters)).toThrow(/unknown character "ghost"/);
  });
});
