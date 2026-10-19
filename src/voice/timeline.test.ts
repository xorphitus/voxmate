import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/audio_query_konnichiwa.json";
import { buildTimeline, phraseStarts, segmentAt, timelineDuration, type AudioQuery } from "./timeline";

const query = fixture as AudioQuery;
const withQuery = (patch: Partial<AudioQuery>): AudioQuery => ({ ...query, ...patch });

describe("buildTimeline", () => {
  it("covers pre + all phonemes + pause + post", () => {
    const tl = buildTimeline(query);
    expect(timelineDuration(tl)).toBeCloseTo(1.742, 6);
  });

  it("is contiguous", () => {
    const tl = buildTimeline(query);
    expect(tl[0].start).toBe(0);
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i].start).toBeCloseTo(tl[i - 1].end, 9);
    }
  });

  it("starts and ends closed", () => {
    const tl = buildTimeline(query);
    expect(tl[0]).toMatchObject({ start: 0, vowel: null });
    expect(tl[0].end).toBeCloseTo(0.1, 9);
    expect(tl[tl.length - 1].vowel).toBeNull();
    expect(tl[tl.length - 1].end - tl[tl.length - 1].start).toBeCloseTo(0.1, 9);
  });

  it("maps moras to vowel shapes", () => {
    const tl = buildTimeline(query);
    // コ: k keeps the previous (closed) shape, then o.
    expect(segmentAt(tl, 0.1 + 0.03)).toMatchObject({ vowel: null });
    expect(segmentAt(tl, 0.1 + 0.0556 + 0.05)).toMatchObject({ vowel: "o", weight: 1 });
    // ン closes the mouth.
    expect(segmentAt(tl, 0.1 + 0.148 + 0.03)).toMatchObject({ vowel: null });
    // ワ's /a/ is the last voiced sound before the pause.
    expect(segmentAt(tl, 0.1 + 0.6899 - 0.01)).toMatchObject({ vowel: "a", weight: 1 });
  });

  it("holds the previous vowel at reduced weight through a consonant", () => {
    const tl = buildTimeline(query);
    // チ's "ch" follows ニ's /i/.
    const t = 0.1 + 0.3065 + 0.03;
    expect(segmentAt(tl, t)).toMatchObject({ vowel: "i", weight: 0.5 });
  });

  it("closes the lips for bilabials, cl and devoiced vowels are faint", () => {
    const tl = buildTimeline(query);
    const phrase2 = 0.1 + 1.0064;
    expect(segmentAt(tl, phrase2 + 0.03)).toMatchObject({ vowel: null }); // m
    expect(segmentAt(tl, phrase2 + 0.1649 + 0.04)).toMatchObject({ vowel: null }); // ッ
    expect(segmentAt(tl, phrase2 + 0.2483 + 0.0711 + 0.02)).toMatchObject({
      vowel: "u",
      weight: 0.3,
    }); // ス (devoiced U)
  });

  it("inserts the pause mora as silence", () => {
    const tl = buildTimeline(query);
    const pause = segmentAt(tl, 0.1 + 0.6899 + 0.1)!;
    expect(pause.vowel).toBeNull();
    expect(pause.end - pause.start).toBeCloseTo(0.3165, 9);
  });

  it("divides every duration by speedScale", () => {
    const base = buildTimeline(query);
    const fast = buildTimeline(withQuery({ speedScale: 2 }));
    expect(fast).toHaveLength(base.length);
    expect(timelineDuration(fast)).toBeCloseTo(1.742 / 2, 6);
    fast.forEach((s, i) => {
      expect(s.start).toBeCloseTo(base[i].start / 2, 9);
      expect(s.vowel).toBe(base[i].vowel);
    });
  });

  it("treats a non-positive speedScale as 1", () => {
    expect(timelineDuration(buildTimeline(withQuery({ speedScale: 0 })))).toBeCloseTo(1.742, 6);
  });

  it("applies pauseLength and pauseLengthScale", () => {
    const overridden = buildTimeline(withQuery({ pauseLength: 0.5 }));
    expect(timelineDuration(overridden)).toBeCloseTo(1.742 - 0.3165 + 0.5, 6);
    const scaled = buildTimeline(withQuery({ pauseLengthScale: 2 }));
    expect(timelineDuration(scaled)).toBeCloseTo(1.742 + 0.3165, 6);
  });

  it("handles an empty query", () => {
    const tl = buildTimeline(withQuery({ accent_phrases: [], prePhonemeLength: 0, postPhonemeLength: 0 }));
    expect(tl).toEqual([]);
    expect(timelineDuration(tl)).toBe(0);
  });
});

describe("segmentAt", () => {
  const tl = buildTimeline(query);
  it("returns null outside the timeline", () => {
    expect(segmentAt(tl, -0.01)).toBeNull();
    expect(segmentAt(tl, 10)).toBeNull();
    expect(segmentAt([], 0)).toBeNull();
  });
  it("uses half-open intervals", () => {
    expect(segmentAt(tl, tl[1].start)).toBe(tl[1]);
  });
});

describe("phraseStarts", () => {
  it("starts each accent phrase where its first mora starts in the timeline", () => {
    const starts = phraseStarts(query);
    expect(starts).toHaveLength(query.accent_phrases.length);
    expect(starts[0]).toBeCloseTo(query.prePhonemeLength, 9);
    // The second phrase starts after the first phrase's moras and pause.
    const tl = buildTimeline(query);
    const first = query.accent_phrases[0];
    const firstLength =
      first.moras.reduce((t, m) => t + (m.consonant ? (m.consonant_length ?? 0) : 0) + m.vowel_length, 0) +
      (first.pause_mora?.vowel_length ?? 0);
    if (starts.length > 1) expect(starts[1]).toBeCloseTo(query.prePhonemeLength + firstLength, 9);
    expect(starts[starts.length - 1]).toBeLessThan(timelineDuration(tl));
  });

  it("scales with speed", () => {
    const slow = phraseStarts(query);
    const fast = phraseStarts(withQuery({ speedScale: 2 }));
    fast.forEach((t, i) => expect(t).toBeCloseTo(slow[i] / 2, 9));
  });
});
