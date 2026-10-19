import type { AccentPhrase, AudioQuery, Mora } from "../voice/timeline";

/** The VOICEVOX editor's slider ranges. */
export const PITCH_RANGE = { min: 3, max: 6.5, step: 0.01 };
export const LENGTH_RANGE = { min: 0, max: 0.3, step: 0.001 };

/** Which values the engine recomputes (`MoraUpdate` in src-tauri/src/voicevox.rs). */
export type MoraUpdate = "data" | "pitch" | "length";
/** Calls the engine's `/mora_data`, `/mora_pitch` or `/mora_length`. */
export type UpdateMoras = (update: MoraUpdate, phrases: AccentPhrase[]) => Promise<AccentPhrase[]>;

function withPhrases(query: AudioQuery, phrases: AccentPhrase[]): AudioQuery {
  return { ...query, accent_phrases: phrases };
}

/**
 * Moves phrase `index`'s accent to mora `accent` (1-based) and lets the engine
 * recompute that phrase's pitch and length. The whole query goes to the
 * engine, since pitch depends on the neighbors, but only the changed phrase is
 * taken back, so edits to the others survive. Passing the current accent
 * resets the phrase to the engine's values.
 */
export async function changeAccent(
  query: AudioQuery,
  index: number,
  accent: number,
  update: UpdateMoras,
): Promise<AudioQuery> {
  const phrase = query.accent_phrases[index];
  if (!phrase) throw new Error(`no accent phrase ${index}`);
  const accent1 = Math.min(Math.max(Math.round(accent), 1), phrase.moras.length);
  const phrases = query.accent_phrases.map((p, i) => (i === index ? { ...p, accent: accent1 } : p));
  const fresh = (await update("data", phrases))[index];
  if (!fresh) throw new Error("the engine returned fewer accent phrases than it was sent");
  return withPhrases(
    query,
    phrases.map((p, i) => (i === index ? fresh : p)),
  );
}

/** Sets one mora's pitch or vowel length, clamped to the editor's ranges. */
export function setMora(
  query: AudioQuery,
  phraseIndex: number,
  moraIndex: number,
  patch: Partial<Pick<Mora, "pitch" | "vowel_length">>,
): AudioQuery {
  const clamp = (v: number, r: { min: number; max: number }) => Math.min(Math.max(v, r.min), r.max);
  return withPhrases(
    query,
    query.accent_phrases.map((p, i) =>
      i !== phraseIndex
        ? p
        : {
            ...p,
            moras: p.moras.map((m, j) =>
              j !== moraIndex
                ? m
                : {
                    ...m,
                    ...(patch.pitch !== undefined && { pitch: clamp(patch.pitch, PITCH_RANGE) }),
                    ...(patch.vowel_length !== undefined && {
                      vowel_length: clamp(patch.vowel_length, LENGTH_RANGE),
                    }),
                  },
            ),
          },
    ),
  );
}

/** Unvoiced moras (pitch 0) have no pitch to edit. */
export const isVoiced = (mora: Mora) => mora.pitch > 0;
