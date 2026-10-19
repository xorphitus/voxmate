import { sanitizeVoice, type VoiceParams } from "./voice/params";

/**
 * A character bundles what used to be single global settings: the model, the
 * voice and the persona. Lines name a character by `id`.
 */
export interface Character {
  /** Stable slug used by the API (`character` in `POST /speak`). */
  id: string;
  /** Display name. */
  name: string;
  modelPath: string | null;
  /** VOICEVOX style id. */
  speaker: number;
  /** LLM system prompt. */
  persona: string;
  /** Overrides the LLM model from Settings when not empty. */
  llmModel: string;
  /** Default voice; a line's own `voice` overrides it field by field. */
  voice: VoiceParams;
}

export const DEFAULT_SPEAKER = 3; // ずんだもん (ノーマル) in the default engine
export const DEFAULT_PERSONA =
  "あなたはデスクトップのキャラクターです。読み上げられるので、記号や絵文字を使わず、話し言葉で短く答えてください。";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Why `id` can't be used, or null if it can. `self` is the character being renamed. */
export function idError(id: string, characters: Character[], self?: Character): string | null {
  if (!ID_PATTERN.test(id)) {
    return "Character id must be 1-64 characters of a-z, 0-9, - and _, starting with a letter or digit.";
  }
  if (characters.some((c) => c !== self && c.id === id)) return `Character id "${id}" is already used.`;
  return null;
}

/** `base`, or `base-2`, `base-3`… if taken. */
export function uniqueId(base: string, characters: Character[]): string {
  const ids = new Set(characters.map((c) => c.id));
  if (!ids.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export function newCharacter(characters: Character[], template?: Character): Character {
  if (template) {
    return {
      ...template,
      id: uniqueId(`${template.id}-copy`.slice(0, 64), characters),
      name: `${template.name} (copy)`,
      voice: { ...template.voice },
    };
  }
  return {
    id: uniqueId("character", characters),
    name: "New character",
    modelPath: null,
    speaker: DEFAULT_SPEAKER,
    persona: DEFAULT_PERSONA,
    llmModel: "",
    voice: {},
  };
}

/** Pre-character settings keys, still read once to build the first character. */
export interface LegacySettings {
  modelPath?: unknown;
  speaker?: unknown;
  llmSystemPrompt?: unknown;
}

/** The default character, carrying over whatever the old single-character settings held. */
export function migrateCharacter(legacy: LegacySettings): Character {
  return {
    id: "default",
    name: "Default",
    modelPath: typeof legacy.modelPath === "string" ? legacy.modelPath : null,
    speaker: typeof legacy.speaker === "number" ? legacy.speaker : DEFAULT_SPEAKER,
    persona: typeof legacy.llmSystemPrompt === "string" ? legacy.llmSystemPrompt : DEFAULT_PERSONA,
    llmModel: "",
    voice: {},
  };
}

/** Drops malformed entries and duplicate ids from stored characters, filling in missing fields. */
export function sanitizeCharacters(stored: unknown): Character[] {
  if (!Array.isArray(stored)) return [];
  const out: Character[] = [];
  for (const raw of stored) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as Partial<Record<keyof Character, unknown>>;
    if (typeof c.id !== "string" || idError(c.id, out)) continue;
    out.push({
      id: c.id,
      name: typeof c.name === "string" ? c.name : c.id,
      modelPath: typeof c.modelPath === "string" ? c.modelPath : null,
      speaker: typeof c.speaker === "number" ? c.speaker : DEFAULT_SPEAKER,
      persona: typeof c.persona === "string" ? c.persona : "",
      llmModel: typeof c.llmModel === "string" ? c.llmModel : "",
      voice: sanitizeVoice(c.voice),
    });
  }
  return out;
}

/** The character a line names, or the default one when it names none. */
export function resolveCharacter(characters: Character[], defaultId: string, id?: string): Character {
  const wanted = id ?? defaultId;
  const found = characters.find((c) => c.id === wanted);
  if (found) return found;
  if (id !== undefined) throw new Error(`unknown character "${id}"`);
  // A dangling default falls back to the first character; Config keeps at least one.
  return characters[0];
}

/**
 * Who is on stage, left to right: known ids only, no duplicates, and always
 * including the default character (the one that speaks unaddressed lines).
 */
export function normalizeStage(stored: unknown, characters: Character[], defaultId: string): string[] {
  const known = new Set(characters.map((c) => c.id));
  const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
  const stage = [...new Set(ids)];
  if (known.has(defaultId) && !stage.includes(defaultId)) stage.push(defaultId);
  return stage;
}
