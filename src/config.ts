import { load, type Store } from "@tauri-apps/plugin-store";
import { type Character, migrateCharacter, sanitizeCharacters } from "./characters";
import type { ThemePreference } from "./ui/theme";

/**
 * Persisted settings. Rust also reads `voicevoxUrl`, `apiEnabled`, `apiPort`,
 * `alwaysOnTop` and `transparent` at startup (src-tauri/src/lib.rs), so keep
 * key names in sync.
 */
export interface Settings {
  voicevoxUrl: string;
  /** Never empty; Config.open migrates the old single-character keys. */
  characters: Character[];
  /** Id of the character on stage, used by lines that name none. */
  defaultCharacter: string;
  volume: number;
  apiEnabled: boolean;
  apiPort: number;
  alwaysOnTop: boolean;
  transparent: boolean;
  theme: ThemePreference;
  /** OpenAI-compatible server root (no `/v1`), e.g. llama-swap. */
  llmUrl: string;
  /** Used unless the character overrides it. */
  llmModel: string;
  /** Past messages sent with each question. */
  llmHistory: number;
}

export const DEFAULT_SETTINGS: Settings = {
  voicevoxUrl: "http://127.0.0.1:50021",
  characters: [],
  defaultCharacter: "default",
  volume: 1,
  apiEnabled: true,
  apiPort: 50080,
  alwaysOnTop: false,
  transparent: false,
  theme: "system",
  llmUrl: "http://127.0.0.1:8080", // llama-swap's default listen address
  llmModel: "",
  llmHistory: 20,
};

export const SETTINGS_FILE = "settings.json";

export class Config {
  private constructor(
    private readonly store: Store,
    private values: Settings,
  ) {}

  static async open(): Promise<Config> {
    const store = await load(SETTINGS_FILE, { defaults: {}, autoSave: 200 });
    const values = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const stored = await store.get(key);
      if (stored !== undefined && stored !== null) (values as Record<string, unknown>)[key] = stored;
    }
    const config = new Config(store, values);
    await config.ensureCharacters();
    return config;
  }

  /**
   * Before characters existed, `modelPath`, `speaker` and `llmSystemPrompt`
   * were top-level keys. They become the default character on first run and
   * are left in the store, so the previous release still finds them.
   */
  private async ensureCharacters(): Promise<void> {
    let characters = sanitizeCharacters(this.values.characters);
    if (characters.length === 0) {
      characters = [
        migrateCharacter({
          modelPath: await this.store.get("modelPath"),
          speaker: await this.store.get("speaker"),
          llmSystemPrompt: await this.store.get("llmSystemPrompt"),
        }),
      ];
    }
    await this.set("characters", characters);
    if (!characters.some((c) => c.id === this.values.defaultCharacter)) {
      await this.set("defaultCharacter", characters[0].id);
    }
  }

  all(): Settings {
    return { ...this.values };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  async set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    this.values = { ...this.values, [key]: value };
    await this.store.set(key, value);
  }
}
