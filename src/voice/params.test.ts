import { describe, expect, it } from "vitest";
import { lineVoice, mergeVoice, sanitizeVoice } from "./params";

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

describe("lineVoice", () => {
  const character = { speed: 1.2, pitch: 0.1 };

  it("layers the line over the character's defaults", () => {
    expect(lineVoice(character, { voice: { speed: 0.9 } })).toEqual({ speed: 0.9, pitch: 0.1 });
  });

  it("leaves a given audio_query's values alone except for the line's own voice", () => {
    expect(lineVoice(character, { audioQuery: { accent_phrases: [] } })).toEqual({});
    expect(lineVoice(character, { audioQuery: { accent_phrases: [] }, voice: { pitch: 0 } })).toEqual({ pitch: 0 });
  });
});
