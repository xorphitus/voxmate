import { describe, expect, it } from "vitest";
import type { Character } from "../characters";
import { engineQuery, importVvproj } from "./vvproj";

const characters = [{ id: "zunda", speaker: 3 }, { id: "metan", speaker: 2 }] as Character[];

const appQuery = {
  accentPhrases: [
    {
      moras: [{ text: "コ", consonant: "k", consonantLength: 0.05, vowel: "o", vowelLength: 0.1, pitch: 5.5 }],
      accent: 1,
      pauseMora: { text: "、", vowel: "pau", vowelLength: 0.3, pitch: 0 },
      isInterrogative: false,
    },
  ],
  speedScale: 1.1,
  pitchScale: 0,
  intonationScale: 1,
  volumeScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
  outputSamplingRate: "engineDefault",
  outputStereo: false,
  kana: "コ'、",
};

describe("engineQuery", () => {
  it("converts the editor app's camelCase query to the engine's", () => {
    expect(engineQuery(appQuery)).toEqual({
      accent_phrases: [
        {
          moras: [{ text: "コ", consonant: "k", consonant_length: 0.05, vowel: "o", vowel_length: 0.1, pitch: 5.5 }],
          accent: 1,
          pause_mora: { text: "、", vowel: "pau", vowel_length: 0.3, pitch: 0 },
          is_interrogative: false,
        },
      ],
      speedScale: 1.1,
      pitchScale: 0,
      intonationScale: 1,
      volumeScale: 1,
      prePhonemeLength: 0.1,
      postPhonemeLength: 0.1,
      outputSamplingRate: 24000,
      outputStereo: false,
      kana: "コ'、",
    });
  });

  it("passes engine queries through", () => {
    const q = { accent_phrases: [{ moras: [], accent: 1 }], speedScale: 1, outputSamplingRate: 48000 };
    expect(engineQuery(q)).toEqual(q);
  });
});

describe("importVvproj", () => {
  it("reads the talk track in order, mapping style ids to characters", () => {
    const project = {
      appVersion: "0.22.0",
      talk: {
        audioKeys: ["b", "a", "c"],
        audioItems: {
          a: { text: "二番", voice: { engineId: "e", speakerId: "s", styleId: 2 } },
          b: { text: "一番", voice: { engineId: "e", speakerId: "s", styleId: 3 }, query: appQuery },
          c: { text: "知らない声", voice: { engineId: "e", speakerId: "s", styleId: 46 } },
        },
      },
      song: {},
    };
    const lines = importVvproj(project, characters, "zunda");
    expect(lines.map((l) => [l.text, l.character, l.speaker])).toEqual([
      ["一番", "zunda", undefined],
      ["二番", "metan", undefined],
      ["知らない声", "zunda", 46],
    ]);
    expect(lines[0].audioQuery?.accent_phrases[0].moras[0].vowel_length).toBe(0.1);
  });

  it("reads older projects with the talk track at the top level", () => {
    const old = { audioKeys: ["a"], audioItems: { a: { text: "旧", styleId: 2 } } };
    expect(importVvproj(old, characters, "zunda")[0]).toMatchObject({ text: "旧", character: "metan" });
  });

  it("rejects other files", () => {
    expect(() => importVvproj({ lines: [] }, characters, "zunda")).toThrow(/not a VOICEVOX project/);
  });
});
