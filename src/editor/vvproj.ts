import type { Character } from "../characters";
import type { AudioQuery } from "../voice/timeline";
import { type EditorLine, newKey } from "./scene";

/**
 * Imports the talk track of a VOICEVOX project (`.vvproj`).
 *
 * Current projects are `{ appVersion, talk: { audioKeys, audioItems }, song }`
 * with items `{ text, voice: { engineId, speakerId, styleId }, query }`
 * (src/infrastructures/projectFile/schema.ts in VOICEVOX). Older projects
 * keep `audioKeys`/`audioItems` at the top level and put `styleId` on the
 * item; both are read. The editor app stores queries in camelCase, while the
 * engine (and voxmate's `audioQuery`) uses snake_case for accent phrases and
 * moras, so those keys are converted.
 */
export function importVvproj(json: unknown, characters: Character[], fallbackCharacter: string): EditorLine[] {
  const project = json as Record<string, unknown> | null;
  const talk = (project?.talk ?? project) as { audioKeys?: unknown; audioItems?: unknown } | null;
  const items = talk?.audioItems;
  if (typeof items !== "object" || items === null) throw new Error("not a VOICEVOX project: no talk track");
  const keys = Array.isArray(talk?.audioKeys) ? (talk.audioKeys as string[]) : Object.keys(items);

  return keys.flatMap((key) => {
    const item = (items as Record<string, Record<string, unknown>>)[key];
    if (!item || typeof item.text !== "string") return [];
    const voice = item.voice as { styleId?: unknown } | undefined;
    const styleId = [voice?.styleId, item.styleId, item.speaker].find((v) => typeof v === "number") as number | undefined;
    // A character with that voice, else the line keeps the style id as its speaker.
    const character = styleId === undefined ? undefined : characters.find((c) => c.speaker === styleId);
    const query = item.query ? engineQuery(item.query as Record<string, unknown>) : undefined;
    return [
      {
        key: newKey(),
        character: character?.id ?? fallbackCharacter,
        text: item.text,
        voice: {},
        ...(styleId !== undefined && !character && { speaker: styleId }),
        ...(query && { audioQuery: query }),
      },
    ];
  });
}

const MORA_KEYS: Record<string, string> = { consonantLength: "consonant_length", vowelLength: "vowel_length" };
const PHRASE_KEYS: Record<string, string> = { pauseMora: "pause_mora", isInterrogative: "is_interrogative" };
/** The engine's default `outputSamplingRate`, for projects that say "engineDefault". */
const ENGINE_DEFAULT_RATE = 24000;

function renameKeys(obj: Record<string, unknown>, names: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [names[k] ?? k, v]));
}

/** The editor app's query as the engine takes it. Already snake_case queries pass through. */
export function engineQuery(query: Record<string, unknown>): AudioQuery {
  const { accentPhrases, ...rest } = query;
  const phrases = (Array.isArray(accentPhrases) ? accentPhrases : (query.accent_phrases as unknown[]) ?? []).map(
    (p) => {
      const phrase = renameKeys(p as Record<string, unknown>, PHRASE_KEYS);
      const mora = (m: unknown) => (m && typeof m === "object" ? renameKeys(m as Record<string, unknown>, MORA_KEYS) : m);
      return {
        ...phrase,
        moras: Array.isArray(phrase.moras) ? phrase.moras.map(mora) : [],
        ...(phrase.pause_mora ? { pause_mora: mora(phrase.pause_mora) } : {}),
      };
    },
  );
  const out: Record<string, unknown> = { ...rest, accent_phrases: phrases };
  if (typeof out.outputSamplingRate !== "number") out.outputSamplingRate = ENGINE_DEFAULT_RATE;
  return out as AudioQuery;
}
