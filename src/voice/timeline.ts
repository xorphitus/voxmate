/**
 * Converts a VOICEVOX `audio_query` into a mouth-shape timeline.
 *
 * The engine renders phonemes back to back in this order:
 *   prePhonemeLength, then per accent phrase each mora's
 *   consonant_length + vowel_length, then the phrase's pause_mora,
 *   and finally postPhonemeLength — all divided by speedScale.
 */

export type Vowel = "a" | "i" | "u" | "e" | "o";
export const VOWELS: readonly Vowel[] = ["a", "i", "u", "e", "o"];

export interface Mora {
  text: string;
  consonant?: string | null;
  consonant_length?: number | null;
  vowel: string;
  vowel_length: number;
  pitch: number;
}

export interface AccentPhrase {
  moras: Mora[];
  accent: number;
  pause_mora?: Mora | null;
  is_interrogative?: boolean;
}

export interface AudioQuery {
  accent_phrases: AccentPhrase[];
  speedScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  /** Newer engines: overrides every pause_mora length when not null. */
  pauseLength?: number | null;
  /** Newer engines: multiplies every pause length. */
  pauseLengthScale?: number;
  [key: string]: unknown;
}

export interface Segment {
  start: number;
  end: number;
  /** `null` means a closed mouth. */
  vowel: Vowel | null;
  /** How far the mouth opens for `vowel`, 0..1. */
  weight: number;
}

/** Consonants articulated with the lips closed. */
const BILABIALS = new Set(["m", "my", "b", "by", "p", "py"]);
/** Mouth shape kept from the previous vowel while a consonant sounds. */
const CONSONANT_WEIGHT = 0.5;
/** Devoiced vowels (uppercase in VOICEVOX) are barely visible. */
const DEVOICED_WEIGHT = 0.3;

function vowelOf(phoneme: string): { vowel: Vowel | null; weight: number } {
  const lower = phoneme.toLowerCase();
  if ((VOWELS as readonly string[]).includes(lower)) {
    return { vowel: lower as Vowel, weight: phoneme === lower ? 1 : DEVOICED_WEIGHT };
  }
  // "N" (moraic nasal), "cl" (geminate stop), "pau" and anything unknown.
  return { vowel: null, weight: 0 };
}

export function buildTimeline(query: AudioQuery): Segment[] {
  const speed = query.speedScale > 0 ? query.speedScale : 1;
  const segments: Segment[] = [];
  let t = 0;
  let prev: Vowel | null = null;

  const push = (length: number, vowel: Vowel | null, weight: number) => {
    const d = Math.max(0, length) / speed;
    if (d <= 0) return;
    segments.push({ start: t, end: t + d, vowel, weight: vowel ? weight : 0 });
    t += d;
  };

  push(query.prePhonemeLength, null, 0);

  for (const phrase of query.accent_phrases) {
    for (const mora of phrase.moras) {
      if (mora.consonant && mora.consonant_length) {
        if (BILABIALS.has(mora.consonant)) push(mora.consonant_length, null, 0);
        else push(mora.consonant_length, prev, CONSONANT_WEIGHT);
      }
      const { vowel, weight } = vowelOf(mora.vowel);
      push(mora.vowel_length, vowel, weight);
      prev = vowel;
    }
    if (phrase.pause_mora) {
      const base = query.pauseLength ?? phrase.pause_mora.vowel_length;
      push(base * (query.pauseLengthScale ?? 1), null, 0);
      prev = null;
    }
  }

  push(query.postPhonemeLength, null, 0);
  return segments;
}

export function timelineDuration(segments: readonly Segment[]): number {
  return segments.length ? segments[segments.length - 1].end : 0;
}

/** Binary search for the segment active at `t` (seconds). */
export function segmentAt(segments: readonly Segment[], t: number): Segment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.start) hi = mid - 1;
    else if (t >= s.end) lo = mid + 1;
    else return s;
  }
  return null;
}

/**
 * When each accent phrase starts, in seconds, with the same timing rules as
 * `buildTimeline`. Cues use it to act at a phrase ("at": {"phrase": n}).
 */
export function phraseStarts(query: AudioQuery): number[] {
  const speed = query.speedScale > 0 ? query.speedScale : 1;
  const len = (x: number | null | undefined) => Math.max(0, x ?? 0) / speed;
  const starts: number[] = [];
  let t = len(query.prePhonemeLength);
  for (const phrase of query.accent_phrases) {
    starts.push(t);
    for (const mora of phrase.moras) t += len(mora.consonant ? mora.consonant_length : 0) + len(mora.vowel_length);
    if (phrase.pause_mora) t += len((query.pauseLength ?? phrase.pause_mora.vowel_length) * (query.pauseLengthScale ?? 1));
  }
  return starts;
}
