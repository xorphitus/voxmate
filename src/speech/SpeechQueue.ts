import type { Utterance } from "./TextSource";

export interface SpeechQueueDeps<P> {
  /** Synthesize/decode ahead of time. Called for the next item while the current one plays. */
  prepare(utterance: Utterance): Promise<P>;
  /** Play prepared audio; resolve when finished or stopped. */
  play(prepared: P, utterance: Utterance): Promise<void>;
  /** Interrupt whatever `play` is doing. */
  stop(): void;
  onError?(error: unknown, utterance: Utterance): void;
  onStateChange?(state: { speaking: Utterance | null; pending: number }): void;
}

interface Item<P> {
  utterance: Utterance;
  prepared?: Promise<P>;
}

/**
 * Serializes utterances from every source so they never overlap. Synthesis of
 * the next utterance overlaps playback of the current one to cut gaps.
 */
export class SpeechQueue<P> {
  private items: Item<P>[] = [];
  private running = false;
  private current: Utterance | null = null;
  /** Bumped by clear() so in-flight work from before it is dropped. */
  private generation = 0;

  constructor(private readonly deps: SpeechQueueDeps<P>) {}

  get pending(): number {
    return this.items.length;
  }

  enqueue(utterance: Utterance): void {
    const text = utterance.text.trim();
    if (!text) return;
    this.items.push({ utterance: { ...utterance, text } });
    this.notify();
    if (!this.running) void this.run();
  }

  /** Drop everything queued and stop the current utterance. */
  clear(): void {
    this.items = [];
    this.generation++;
    this.deps.stop();
    this.notify();
  }

  private prepare(item: Item<P>): Promise<P> {
    if (!item.prepared) {
      item.prepared = this.deps.prepare(item.utterance);
      // Avoid unhandled-rejection noise if the item is cleared before use.
      item.prepared.catch(() => {});
    }
    return item.prepared;
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      let item: Item<P> | undefined;
      while ((item = this.items.shift())) {
        const generation = this.generation;
        try {
          const prepared = await this.prepare(item);
          if (generation !== this.generation) continue;
          if (this.items[0]) this.prepare(this.items[0]);
          this.current = item.utterance;
          this.notify();
          await this.deps.play(prepared, item.utterance);
        } catch (error) {
          if (generation === this.generation) this.deps.onError?.(error, item.utterance);
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.running = false;
      this.notify();
    }
  }

  private notify(): void {
    this.deps.onStateChange?.({ speaking: this.current, pending: this.items.length });
  }
}
