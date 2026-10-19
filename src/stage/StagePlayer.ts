import type { Line, LineDraft, LineEvent, LineState, QueuePosition, Scene } from "./Line";

export interface StagePlayerDeps<P> {
  /** Synthesize/decode ahead of time. Called for the next line while the current one plays. */
  prepare(line: Line): Promise<P>;
  /** Play prepared audio; resolve when finished or stopped. */
  play(prepared: P, line: Line): Promise<void>;
  /** Interrupt whatever `play` is doing. */
  stop(): void;
  /** Character for drafts that name none, read when the line is queued. */
  defaultCharacter(): string;
  newId?(): string;
}

export type LineListener = (event: LineEvent) => void;

interface Item<P> {
  line: Line;
  prepared?: Promise<P>;
  /** Dropped while being prepared; its `skipped` event was already sent. */
  cancelled?: boolean;
}

/**
 * Serializes lines from every producer so they never overlap. Synthesis of the
 * next line overlaps playback of the current one to cut gaps. Every line
 * reports its lifecycle to subscribers.
 */
export class StagePlayer<P> {
  private items: Item<P>[] = [];
  private running = false;
  /** Taken off the queue: being prepared (awaited) or played. */
  private active: Item<P> | null = null;
  private playing = false;
  /** The playing line was stopped on purpose, so it ends as `interrupted`. */
  private interrupting = false;
  private listeners = new Set<LineListener>();
  private readonly newId: () => string;

  constructor(private readonly deps: StagePlayerDeps<P>) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  get pending(): number {
    return this.items.length;
  }

  /** The line being spoken. */
  get current(): Line | null {
    return this.playing && this.active ? this.active.line : null;
  }

  subscribe(listener: LineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Queues one line. Returns it with its id, or null if it has no text. */
  enqueue(draft: LineDraft, position: QueuePosition = "end"): Line | null {
    return this.insert([draft], position)[0] ?? null;
  }

  /** Queues the lines of a scene together. Blank lines are dropped. */
  enqueueScene(scene: Scene, position: QueuePosition = "end"): Line[] {
    const sceneId = scene.id ?? this.newId();
    return this.insert(
      scene.lines.map((l) => ({ ...l, source: scene.source, sceneId })),
      position,
    );
  }

  /** Drops everything queued and stops the current line. */
  clear(): void {
    this.cancel(() => true);
  }

  /** Stops the current line (or drops it, if it is still being prepared); the next one starts. */
  skip(): void {
    const line = this.active?.line;
    if (line) this.cancel((l) => l === line);
  }

  /** Drops the queued lines of a scene, and stops the current line if it belongs to it. */
  cancelScene(sceneId: string): void {
    this.cancel((line) => line.sceneId === sceneId);
  }

  private insert(drafts: LineDraft[], position: QueuePosition): Line[] {
    const items: Item<P>[] = [];
    for (const draft of drafts) {
      const text = draft.text.trim();
      if (!text) continue;
      const line: Line = {
        ...draft,
        id: draft.id ?? this.newId(),
        character: draft.character ?? this.deps.defaultCharacter(),
        text,
      };
      items.push({ line });
    }
    if (items.length === 0) return [];

    const at = position === "next" ? this.afterCurrentScene() : this.items.length;
    this.items.splice(at, 0, ...items);
    for (const item of items) this.emit(item.line, "queued");
    // Keep preparing ahead when the line after the current one changed.
    if (at === 0 && this.playing) this.prepare(this.items[0]);
    if (!this.running) void this.run();
    return items.map((i) => i.line);
  }

  /** Index right after the queued rest of the current line's scene. */
  private afterCurrentScene(): number {
    const sceneId = this.active?.line.sceneId;
    if (sceneId === undefined) return 0;
    let at = 0;
    while (at < this.items.length && this.items[at].line.sceneId === sceneId) at++;
    return at;
  }

  private cancel(match: (line: Line) => boolean): void {
    const dropped = this.items.filter((i) => match(i.line));
    this.items = this.items.filter((i) => !match(i.line));
    for (const item of dropped) this.emit(item.line, "skipped");

    const active = this.active;
    if (!active || active.cancelled || !match(active.line)) return;
    if (this.playing) {
      this.interrupting = true;
      this.deps.stop();
    } else {
      active.cancelled = true;
      this.emit(active.line, "skipped");
    }
  }

  private prepare(item: Item<P>): Promise<P> {
    if (!item.prepared) {
      this.emit(item.line, "preparing");
      item.prepared = this.deps.prepare(item.line);
      // Avoid unhandled-rejection noise if the item is dropped before use.
      item.prepared.catch(() => {});
    }
    return item.prepared;
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      let item: Item<P> | undefined;
      while ((item = this.items.shift())) {
        this.active = item;
        if (item.line.direction) {
          this.emit(item.line, "done");
          continue;
        }
        let prepared: P;
        try {
          prepared = await this.prepare(item);
        } catch (error) {
          if (!item.cancelled) this.emit(item.line, "failed", error);
          continue;
        }
        if (item.cancelled) continue;

        this.playing = true;
        this.emit(item.line, "speaking");
        if (this.items[0]) this.prepare(this.items[0]);
        let state: LineState = "done";
        let failure: unknown;
        try {
          await this.deps.play(prepared, item.line);
        } catch (error) {
          state = "failed";
          failure = error;
        }
        if (this.interrupting) state = "interrupted";
        this.playing = false;
        this.interrupting = false;
        this.active = null;
        this.emit(item.line, state, failure);
      }
    } finally {
      this.active = null;
      this.running = false;
    }
  }

  private emit(line: Line, state: LineState, error?: unknown): void {
    const event: LineEvent = state === "failed" ? { line, state, error } : { line, state };
    for (const listener of this.listeners) {
      // A broken listener must not stall the queue.
      try {
        listener(event);
      } catch (e) {
        console.error(e);
      }
    }
  }
}
