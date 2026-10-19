import { LipSyncDriver, type PlaybackClock } from "../lipsync/LipSyncDriver";
import type { Segment } from "../voice/timeline";
import type { Avatar } from "./Avatar";

/** A character as the stage shows it. */
export interface MemberSpec {
  id: string;
  name: string;
  modelPath: string | null;
}

export type MemberStatus = "empty" | "loading" | "loaded" | "error";

export interface MemberState {
  id: string;
  name: string;
  status: MemberStatus;
  error?: string;
}

/**
 * Where one member is drawn. The DOM version is `domSlots`; the stage logic
 * doesn't depend on the layout, so per-character windows could provide
 * their own slots later.
 */
export interface Slot {
  /** What the avatar renders into. */
  readonly container: HTMLElement;
  /** Position `index` of `count`, left to right. */
  place(index: number, count: number): void;
  /** A caption shown while there is no model (null hides it). */
  setLabel(text: string | null, error?: boolean): void;
  remove(): void;
}

export interface StageViewDeps {
  /** The audio player; every member's driver reads the same clock. */
  clock: PlaybackClock;
  createSlot(): Slot;
  /** Creates an avatar for `path` in `container` and loads the model. */
  loadAvatar(path: string, container: HTMLElement): Promise<Avatar>;
  onChange?(members: MemberState[]): void;
}

interface Member {
  spec: MemberSpec;
  slot: Slot;
  driver: LipSyncDriver;
  avatar: Avatar | null;
  status: MemberStatus;
  error?: string;
  /** Bumped per model change, so a slow load can't replace a newer one. */
  generation: number;
}

export interface StagePlan {
  remove: string[];
  add: MemberSpec[];
  /** Members whose model path changed. */
  reload: MemberSpec[];
}

/** What `sync` has to do to go from the current members to `next`. */
export function planStage(current: { id: string; modelPath: string | null }[], next: MemberSpec[]): StagePlan {
  const wanted = new Map(next.map((m) => [m.id, m]));
  const have = new Map(current.map((m) => [m.id, m]));
  return {
    remove: current.filter((m) => !wanted.has(m.id)).map((m) => m.id),
    add: next.filter((m) => !have.has(m.id)),
    reload: next.filter((m) => have.has(m.id) && have.get(m.id)!.modelPath !== m.modelPath),
  };
}

/**
 * The characters on stage, each in its own slot with its own avatar and
 * lip-sync driver. Only the speaking member gets the timeline; the others
 * close their mouths. Per-member drivers also keep loudness normalization
 * separate per voice. VRM and Live2D can be mixed.
 */
export class StageView {
  private members: Member[] = [];

  constructor(private readonly deps: StageViewDeps) {}

  get state(): MemberState[] {
    return this.members.map(({ spec, status, error }) => ({
      id: spec.id,
      name: spec.name,
      status,
      ...(error !== undefined && { error }),
    }));
  }

  /** Makes the stage show `specs`, in order. Resolves once every model has loaded or failed. */
  async sync(specs: MemberSpec[]): Promise<void> {
    const plan = planStage(
      this.members.map((m) => ({ id: m.spec.id, modelPath: m.spec.modelPath })),
      specs,
    );
    for (const id of plan.remove) this.removeMember(id);
    for (const spec of plan.add) {
      this.members.push({
        spec,
        slot: this.deps.createSlot(),
        driver: new LipSyncDriver(this.deps.clock),
        avatar: null,
        status: "empty",
        generation: 0,
      });
    }
    const byId = new Map(this.members.map((m) => [m.spec.id, m]));
    this.members = specs.map((spec) => {
      const member = byId.get(spec.id)!;
      member.spec = spec;
      return member;
    });
    this.members.forEach((m, i) => m.slot.place(i, this.members.length));
    this.resize();

    const loads = [...plan.add, ...plan.reload].map((spec) => this.load(byId.get(spec.id)!));
    this.changed();
    await Promise.all(loads);
  }

  /** Routes the timeline to `characterId`'s member; everyone else closes their mouth. */
  speak(characterId: string, timeline: readonly Segment[]): void {
    for (const m of this.members) {
      if (m.spec.id === characterId) m.driver.setTimeline(timeline);
      else m.driver.clear();
    }
  }

  silence(): void {
    for (const m of this.members) m.driver.clear();
  }

  tick(dt: number): void {
    for (const m of this.members) {
      m.driver.tick(dt, m.avatar);
      m.avatar?.update(dt);
    }
  }

  resize(): void {
    for (const m of this.members) m.avatar?.resize();
  }

  dispose(): void {
    for (const m of [...this.members]) this.removeMember(m.spec.id);
  }

  private async load(member: Member): Promise<void> {
    const generation = ++member.generation;
    const path = member.spec.modelPath;
    if (!path) {
      member.avatar?.dispose();
      member.avatar = null;
      this.setStatus(member, "empty");
      return;
    }
    // Keep showing the previous model until the new one is ready.
    if (!member.avatar) this.setStatus(member, "loading");
    let next: Avatar | null = null;
    try {
      next = await this.deps.loadAvatar(path, member.slot.container);
    } catch (e) {
      if (generation !== member.generation || !this.members.includes(member)) return;
      member.avatar?.dispose();
      member.avatar = null;
      this.setStatus(member, "error", e instanceof Error ? e.message : String(e));
      return;
    }
    if (generation !== member.generation || !this.members.includes(member)) {
      next.dispose();
      return;
    }
    member.avatar?.dispose();
    member.avatar = next;
    this.setStatus(member, "loaded");
  }

  private setStatus(member: Member, status: MemberStatus, error?: string): void {
    member.status = status;
    member.error = error;
    const { name } = member.spec;
    const label =
      status === "loaded"
        ? null
        : status === "loading"
          ? `${name}: loading…`
          : status === "error"
            ? `${name}: could not load the model (${error})`
            : `${name}: no model`;
    member.slot.setLabel(label, status === "error");
    this.changed();
  }

  private removeMember(id: string): void {
    const member = this.members.find((m) => m.spec.id === id);
    if (!member) return;
    member.generation++;
    member.avatar?.dispose();
    member.slot.remove();
    this.members = this.members.filter((m) => m !== member);
  }

  private changed(): void {
    this.deps.onChange?.(this.state);
  }
}

/** Slots as absolutely positioned columns of `stage`, each with a caption. */
export function domSlots(stage: HTMLElement): () => Slot {
  return () => {
    const container = document.createElement("div");
    container.className = "slot";
    const label = document.createElement("p");
    label.className = "slot-label";
    label.hidden = true;
    container.append(label);
    stage.append(container);
    return {
      container,
      place(index, count) {
        container.style.left = `${(index / count) * 100}%`;
        container.style.width = `${100 / count}%`;
      },
      setLabel(text, error = false) {
        label.hidden = text === null;
        label.textContent = text ?? "";
        label.classList.toggle("error", error);
      },
      remove() {
        container.remove();
      },
    };
  };
}
