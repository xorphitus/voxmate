import { describe, expect, it } from "vitest";
import {
  type Character,
  DEFAULT_PERSONA,
  DEFAULT_SPEAKER,
  idError,
  migrateCharacter,
  normalizeStage,
  newCharacter,
  resolveCharacter,
  sanitizeCharacters,
  uniqueId,
} from "./characters";

const character = (id: string, speaker = 1): Character => ({
  id,
  name: id.toUpperCase(),
  modelPath: null,
  speaker,
  persona: "",
  llmModel: "",
  voice: {},
});

describe("migrateCharacter", () => {
  it("carries the old single-character settings over", () => {
    expect(migrateCharacter({ modelPath: "/m/a.vrm", speaker: 8, llmSystemPrompt: "be nice" })).toEqual({
      id: "default",
      name: "Default",
      modelPath: "/m/a.vrm",
      speaker: 8,
      persona: "be nice",
      llmModel: "",
      voice: {},
    });
  });

  it("uses defaults for a fresh install", () => {
    expect(migrateCharacter({})).toMatchObject({ modelPath: null, speaker: DEFAULT_SPEAKER, persona: DEFAULT_PERSONA });
  });
});

describe("sanitizeCharacters", () => {
  it("drops malformed entries and duplicate ids, and fills missing fields", () => {
    const stored = [{ id: "a", speaker: 2, voice: { speed: 1.5, pitch: 9 } }, { id: "a" }, { id: "Bad id" }, null, "x", { name: "no id" }];
    expect(sanitizeCharacters(stored)).toEqual([
      { id: "a", name: "a", modelPath: null, speaker: 2, persona: "", llmModel: "", voice: { speed: 1.5 } },
    ]);
  });

  it("returns nothing for a non-array", () => {
    expect(sanitizeCharacters(undefined)).toEqual([]);
  });
});

describe("ids", () => {
  it("accepts slugs and rejects anything else", () => {
    const list = [character("taken")];
    expect(idError("zunda_2-b", list)).toBeNull();
    expect(idError("", list)).not.toBeNull();
    expect(idError("-a", list)).not.toBeNull();
    expect(idError("Zunda", list)).not.toBeNull();
    expect(idError("a".repeat(65), list)).not.toBeNull();
    expect(idError("taken", list)).toMatch(/already used/);
    expect(idError("taken", list, list[0])).toBeNull();
  });

  it("numbers ids that are taken", () => {
    expect(uniqueId("a", [character("b")])).toBe("a");
    expect(uniqueId("a", [character("a"), character("a-2")])).toBe("a-3");
  });
});

describe("newCharacter", () => {
  it("creates a blank character with a free id", () => {
    expect(newCharacter([character("character")])).toMatchObject({ id: "character-2", modelPath: null });
  });

  it("copies a template under a new id", () => {
    const template = { ...character("zunda", 3), modelPath: "/m/z.vrm" };
    expect(newCharacter([template], template)).toEqual({
      ...template,
      id: "zunda-copy",
      name: "ZUNDA (copy)",
    });
  });
});

describe("resolveCharacter", () => {
  const list = [character("a", 1), character("b", 2)];

  it("finds the named character", () => {
    expect(resolveCharacter(list, "a", "b").speaker).toBe(2);
  });

  it("uses the default when none is named", () => {
    expect(resolveCharacter(list, "b").speaker).toBe(2);
  });

  it("falls back to the first character when the default is gone", () => {
    expect(resolveCharacter(list, "gone").id).toBe("a");
  });

  it("rejects an unknown named character", () => {
    expect(() => resolveCharacter(list, "a", "nobody")).toThrow(/unknown character "nobody"/);
  });
});

describe("normalizeStage", () => {
  const list = [character("a"), character("b"), character("c")];

  it("keeps known ids once, in order, and always the default", () => {
    expect(normalizeStage(["c", "x", "c", 3, "a"], list, "a")).toEqual(["c", "a"]);
    expect(normalizeStage(["c"], list, "b")).toEqual(["c", "b"]);
    expect(normalizeStage(undefined, list, "a")).toEqual(["a"]);
  });
});
