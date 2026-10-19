import { describe, expect, it, vi } from "vitest";
import type { AccentPhrase, AudioQuery, Mora } from "../voice/timeline";
import { changeAccent, isVoiced, setMora, type UpdateMoras } from "./accent";

const mora = (text: string, pitch = 5): Mora => ({ text, vowel: "a", vowel_length: 0.1, pitch });
const phrase = (texts: string[], accent: number): AccentPhrase => ({ moras: texts.map((t) => mora(t)), accent });
const query = (...phrases: AccentPhrase[]): AudioQuery => ({
  accent_phrases: phrases,
  speedScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
});

/** An engine that sets every pitch from the accent, to see which phrases were taken back. */
const engine: UpdateMoras = async (_update, phrases) =>
  phrases.map((p) => ({ ...p, moras: p.moras.map((m) => ({ ...m, pitch: 4 + p.accent / 10 })) }));

describe("changeAccent", () => {
  it("moves the accent and takes back only that phrase from the engine", async () => {
    const edited = setMora(query(phrase(["コ", "ン"], 1), phrase(["ワ"], 1)), 1, 0, { pitch: 6 });
    const update = vi.fn(engine);
    const out = await changeAccent(edited, 0, 2, update);
    expect(update).toHaveBeenCalledWith("data", [
      { ...edited.accent_phrases[0], accent: 2 },
      edited.accent_phrases[1],
    ]);
    expect(out.accent_phrases[0].accent).toBe(2);
    expect(out.accent_phrases[0].moras.map((m) => m.pitch)).toEqual([4.2, 4.2]);
    // The other phrase keeps its hand edit.
    expect(out.accent_phrases[1].moras[0].pitch).toBe(6);
    expect(out.speedScale).toBe(1);
  });

  it("clamps the accent to the phrase", async () => {
    const out = await changeAccent(query(phrase(["ア", "イ"], 1)), 0, 9, engine);
    expect(out.accent_phrases[0].accent).toBe(2);
  });

  it("rejects a short engine answer", async () => {
    await expect(changeAccent(query(phrase(["ア"], 1)), 0, 1, async () => [])).rejects.toThrow(/fewer/);
  });
});

describe("setMora", () => {
  it("edits one mora within the ranges without touching the input", () => {
    const q = query(phrase(["ア", "イ"], 1));
    const out = setMora(q, 0, 1, { pitch: 99, vowel_length: 0.2 });
    expect(out.accent_phrases[0].moras[1]).toMatchObject({ pitch: 6.5, vowel_length: 0.2 });
    expect(out.accent_phrases[0].moras[0]).toBe(q.accent_phrases[0].moras[0]);
    expect(q.accent_phrases[0].moras[1].pitch).toBe(5);
  });

  it("knows unvoiced moras", () => {
    expect(isVoiced(mora("ス", 0))).toBe(false);
    expect(isVoiced(mora("ア"))).toBe(true);
  });
});
