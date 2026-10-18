import { closedMouth, type Avatar, type VowelWeights } from "../avatar/Avatar";
import { segmentAt, VOWELS, type Segment } from "../voice/timeline";

/** What the driver needs from the audio player. */
export interface PlaybackClock {
  /** Seconds into the current utterance, or < 0 when idle. */
  readonly currentTime: number;
  rms(): number;
}

/** Time constant for blending between mouth shapes. */
const SMOOTHING_SECONDS = 0.05;
/** Peak-follower decay; adapts loudness normalization to the voice. */
const PEAK_DECAY_SECONDS = 2;
const MIN_PEAK = 0.02;
/** Openness = FLOOR + (1 - FLOOR) * normalized loudness while speaking. */
const OPENNESS_FLOOR = 0.35;

/**
 * Each frame: look up the timeline vowel at the playback position, blend
 * toward it, and scale by the normalized RMS of what is actually playing.
 */
export class LipSyncDriver {
  private timeline: readonly Segment[] = [];
  private weights: VowelWeights = closedMouth();
  private openness = 0;
  private peak = MIN_PEAK;

  constructor(private readonly clock: PlaybackClock) {}

  setTimeline(timeline: readonly Segment[]): void {
    this.timeline = timeline;
  }

  clear(): void {
    this.timeline = [];
  }

  /** Current smoothed output (for tests and debugging). */
  get state(): { weights: Readonly<VowelWeights>; openness: number } {
    return { weights: this.weights, openness: this.openness };
  }

  tick(dt: number, avatar: Avatar | null): void {
    const t = this.clock.currentTime;
    const speaking = t >= 0 && this.timeline.length > 0;

    const target = closedMouth();
    const seg = speaking ? segmentAt(this.timeline, t) : null;
    if (seg?.vowel) target[seg.vowel] = seg.weight;

    const k = 1 - Math.exp(-Math.max(dt, 0) / SMOOTHING_SECONDS);
    for (const v of VOWELS) this.weights[v] += (target[v] - this.weights[v]) * k;

    const rms = speaking ? this.clock.rms() : 0;
    this.peak = Math.max(rms, this.peak * Math.exp(-dt / PEAK_DECAY_SECONDS), MIN_PEAK);
    const loudness = Math.min(rms / this.peak, 1);
    const targetOpen = speaking ? OPENNESS_FLOOR + (1 - OPENNESS_FLOOR) * loudness : 0;
    this.openness += (targetOpen - this.openness) * k;

    avatar?.setMouth(this.weights, this.openness);
  }
}
