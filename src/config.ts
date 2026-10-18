import { load, type Store } from "@tauri-apps/plugin-store";
import type { ThemePreference } from "./ui/theme";

/**
 * Persisted settings. Rust also reads `voicevoxUrl`, `apiEnabled`, `apiPort`,
 * `alwaysOnTop` and `transparent` at startup (src-tauri/src/lib.rs), so keep
 * key names in sync.
 */
export interface Settings {
  voicevoxUrl: string;
  /** VOICEVOX style id. */
  speaker: number;
  modelPath: string | null;
  volume: number;
  apiEnabled: boolean;
  apiPort: number;
  alwaysOnTop: boolean;
  transparent: boolean;
  theme: ThemePreference;
}

export const DEFAULT_SETTINGS: Settings = {
  voicevoxUrl: "http://127.0.0.1:50021",
  speaker: 3, // ずんだもん (ノーマル) in the default engine
  modelPath: null,
  volume: 1,
  apiEnabled: true,
  apiPort: 50080,
  alwaysOnTop: false,
  transparent: false,
  theme: "system",
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
    return new Config(store, values);
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
