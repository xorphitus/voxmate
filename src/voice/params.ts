/**
 * How a line sounds. Mirrors `VoiceParams` in src-tauri/src/voicevox.rs, which
 * writes the set fields into the `audio_query` before synthesis.
 */
export interface VoiceParams {
  /** `speedScale` */
  speed?: number;
  /** `pitchScale` */
  pitch?: number;
  /** `intonationScale` */
  intonation?: number;
  /** `volumeScale`; the app volume applies on top. */
  volume?: number;
  /** Seconds of silence before the line. */
  prePhonemeLength?: number;
  /** Seconds of silence after the line. */
  postPhonemeLength?: number;
  /** Multiplies pauses between phrases (newer engines only). */
  pauseLengthScale?: number;
}

export type VoiceField = keyof VoiceParams;

/** The VOICEVOX editor's ranges; Rust rejects values outside them. */
export const VOICE_RANGES: Record<VoiceField, { min: number; max: number; step: number; label: string }> = {
  speed: { min: 0.5, max: 2, step: 0.01, label: "Speed" },
  pitch: { min: -0.15, max: 0.15, step: 0.01, label: "Pitch" },
  intonation: { min: 0, max: 2, step: 0.01, label: "Intonation" },
  volume: { min: 0, max: 2, step: 0.01, label: "Volume" },
  prePhonemeLength: { min: 0, max: 1.5, step: 0.01, label: "Silence before (s)" },
  postPhonemeLength: { min: 0, max: 1.5, step: 0.01, label: "Silence after (s)" },
  pauseLengthScale: { min: 0, max: 2, step: 0.01, label: "Pauses" },
};

export const VOICE_FIELDS = Object.keys(VOICE_RANGES) as VoiceField[];

export function inRange(field: VoiceField, value: number): boolean {
  const { min, max } = VOICE_RANGES[field];
  return Number.isFinite(value) && value >= min && value <= max;
}

/** Keeps only known fields with in-range numbers. */
export function sanitizeVoice(raw: unknown): VoiceParams {
  const voice: VoiceParams = {};
  if (typeof raw !== "object" || raw === null) return voice;
  for (const field of VOICE_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === "number" && inRange(field, value)) voice[field] = value;
  }
  return voice;
}

/** Later layers win; unset fields fall through to earlier ones (and finally to the engine). */
export function mergeVoice(...layers: (VoiceParams | undefined)[]): VoiceParams {
  const voice: VoiceParams = {};
  for (const layer of layers) {
    for (const field of VOICE_FIELDS) {
      const value = layer?.[field];
      if (value !== undefined) voice[field] = value;
    }
  }
  return voice;
}
