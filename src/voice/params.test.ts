import { describe, expect, it } from "vitest";
import { mergeVoice, sanitizeVoice } from "./params";

describe("mergeVoice", () => {
  it("lets the line override the character, field by field", () => {
    expect(mergeVoice({ speed: 1.2, pitch: 0.1 }, { speed: 0.8 }, undefined)).toEqual({ speed: 0.8, pitch: 0.1 });
  });

  it("leaves unset fields to the engine", () => {
    expect(mergeVoice(undefined, {})).toEqual({});
  });
});

describe("sanitizeVoice", () => {
  it("drops unknown fields, non-numbers and out-of-range values", () => {
    expect(sanitizeVoice({ speed: 1.5, pitch: 0.5, volume: "1", extra: 1, intonation: 0 })).toEqual({
      speed: 1.5,
      intonation: 0,
    });
    expect(sanitizeVoice(null)).toEqual({});
  });
});
