import type { Vowel } from "../voice/timeline";

export type VowelWeights = Record<Vowel, number>;

export const closedMouth = (): VowelWeights => ({ a: 0, i: 0, u: 0, e: 0, o: 0 });

export type AvatarKind = "vrm" | "live2d";

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
  /** Advance animation by `dt` seconds and render. */
  update(dt: number): void;
  resize(): void;
  dispose(): void;
}
