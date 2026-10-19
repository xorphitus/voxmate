import type { Vowel } from "../voice/timeline";

export type VowelWeights = Record<Vowel, number>;

export const closedMouth = (): VowelWeights => ({ a: 0, i: 0, u: 0, e: 0, o: 0 });

export type AvatarKind = "vrm" | "live2d";

/** Where to look, relative to the avatar's own view: x right, y up, each -1..1. */
export interface LookTarget {
  x: number;
  y: number;
}

export interface AvatarCapabilities {
  /** Expression names the model has (VRM presets and custom, Live2D expressions). */
  expressions: string[];
  /** Gestures it can do: the procedural nod/shake/tilt plus Live2D motion groups. */
  gestures: string[];
}

/**
 * Everything outside src/avatar talks to avatars only through this interface.
 * Each implementation owns its own canvas inside the container it was given.
 */
export interface Avatar {
  readonly kind: AvatarKind;
  load(url: string): Promise<void>;
  /**
   * @param weights  per-vowel mouth shape, each 0..1
   * @param openness overall loudness-driven scale, 0..1
   */
  setMouth(weights: VowelWeights, openness: number): void;
  /**
   * Shows one expression (fading out the previous one); "neutral" clears.
   * Names the model lacks are ignored.
   */
  setExpression(name: string, weight: number, fadeSeconds: number): void;
  /** Plays a gesture once; names the model lacks are ignored. */
  gesture(name: string): void;
  /** Turns eyes and head toward `target`; null looks at the camera (the user). */
  lookAt(target: LookTarget | null): void;
  /** Valid once `load` has resolved. */
  capabilities(): AvatarCapabilities;
  /** Advance animation by `dt` seconds and render. */
  update(dt: number): void;
  resize(): void;
  dispose(): void;
}
