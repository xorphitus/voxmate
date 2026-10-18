import { parseWav } from "./wav";

/**
 * WebAudio playback of one utterance at a time, with an AnalyserNode tapped
 * for loudness. `currentTime` is what the lip-sync driver follows.
 */
export class AudioPlayer {
  readonly ctx = new AudioContext();
  private readonly gain = this.ctx.createGain();
  private readonly analyser = this.ctx.createAnalyser();
  private readonly samples: Float32Array<ArrayBuffer>;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private finish: (() => void) | null = null;

  constructor() {
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  /** Autoplay policies may start the context suspended; call on user gestures too. */
  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setVolume(volume: number): void {
    this.gain.gain.value = Math.min(Math.max(volume, 0), 1);
  }

  async decode(wav: ArrayBuffer): Promise<AudioBuffer> {
    try {
      const pcm = parseWav(wav);
      const frames = pcm.channels[0]?.length ?? 0;
      const buffer = this.ctx.createBuffer(pcm.channels.length, Math.max(frames, 1), pcm.sampleRate);
      pcm.channels.forEach((data, i) => buffer.copyToChannel(data, i));
      return buffer;
    } catch {
      // Unexpected format: let the browser try.
      return this.ctx.decodeAudioData(wav.slice(0));
    }
  }

  /** Plays `buffer`; resolves when it ends or is stopped. */
  play(buffer: AudioBuffer): Promise<void> {
    this.stop();
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    return new Promise((resolve) => {
      const done = () => {
        if (this.source === source) this.source = null;
        source.disconnect();
        this.finish = null;
        resolve();
      };
      this.finish = done;
      source.onended = done;
      this.source = source;
      this.startedAt = this.ctx.currentTime;
      source.start();
    });
  }

  stop(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    this.finish?.();
  }

  get isPlaying(): boolean {
    return this.source !== null;
  }

  /** Seconds into the current utterance as heard, or -1 when idle. */
  get currentTime(): number {
    if (!this.source) return -1;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.max(0, this.ctx.currentTime - this.startedAt - latency);
  }

  /** Root-mean-square level of the most recent analyser window. */
  rms(): number {
    if (!this.source) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.sqrt(sum / this.samples.length);
  }

  async close(): Promise<void> {
    this.stop();
    await this.ctx.close();
  }
}
