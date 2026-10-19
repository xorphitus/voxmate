import { LipSyncDriver, type PlaybackClock } from "../lipsync/LipSyncDriver";
import type { Segment } from "../voice/timeline";
import type { Avatar, AvatarCapabilities, LookTarget } from "./Avatar";
import { type Cue, modelName, type ScheduledCue } from "./cues";

/** How long an expression, and a listener's gaze, stay after a line ends. */
export const HOLD_SECONDS = 2;
/** Chance that a listener nods when a line ends. */
export const NOD_CHANCE = 0.4;
const EXPRESSION_FADE = 0.3;

/** A character as the stage shows it. */
export interface MemberSpec {
  id: string;
  name: string;
  modelPath: string | null;
  /** The character's model names for portable expressions and gestures, e.g. { happy: "f01" }. */
  names?: Record<string, string>;
}

export type MemberStatus = "empty" | "loading" | "loaded" | "error";

export interface MemberState {
  id: string;
  name: string;
  status: MemberStatus;
  error?: string;
  /** Once loaded. */
  capabilities?: AvatarCapabilities;
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
  random?(): number;
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
  /** When (in stage time) to return to a neutral face and look at the camera again. */
  resetAt?: number;
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
  /** Seconds of ticks, for holds. */
  private elapsed = 0;
  /** The line being spoken: its speaker and the cues not fired yet. */
  private performance: { speaker: string; cues: ScheduledCue[] } | null = null;
  private readonly random: () => number;

  constructor(private readonly deps: StageViewDeps) {
    this.random = deps.random ?? Math.random;
  }

  get state(): MemberState[] {
    return this.members.map(({ spec, status, error, avatar }) => ({
      id: spec.id,
      name: spec.name,
      status,
      ...(error !== undefined && { error }),
      ...(status === "loaded" && avatar && { capabilities: avatar.capabilities() }),
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

  /**
   * Routes the timeline to `characterId`'s member; everyone else closes their
   * mouth and turns toward the speaker, who looks at the user. `cues` fire
   * against the playback clock (see scheduleCues).
   */
  speak(characterId: string, timeline: readonly Segment[], cues: ScheduledCue[] = []): void {
    this.firePending();
    const speaker = this.member(characterId);
    for (const m of this.members) {
      m.resetAt = undefined;
      if (m === speaker) {
        m.driver.setTimeline(timeline);
        m.avatar?.setExpression("neutral", 0, EXPRESSION_FADE);
        m.avatar?.lookAt(null);
      } else {
        m.driver.clear();
        if (speaker) m.avatar?.lookAt(this.direction(m, speaker));
      }
    }
    this.performance = { speaker: characterId, cues: [...cues] };
  }

  /**
   * The line ended: remaining cues fire, listeners sometimes nod, and after
   * HOLD_SECONDS faces relax and everyone looks at the user again.
   */
  silence(): void {
    const speaker = this.performance?.speaker;
    this.firePending();
    for (const m of this.members) {
      m.driver.clear();
      if (speaker !== undefined && m.spec.id !== speaker && this.random() < NOD_CHANCE) m.avatar?.gesture(modelName("nod", m.spec.names));
      m.resetAt = this.elapsed + HOLD_SECONDS;
    }
  }

  tick(dt: number): void {
    this.elapsed += dt;
    this.fireDue(this.deps.clock.currentTime);
    for (const m of this.members) {
      if (m.resetAt !== undefined && this.elapsed >= m.resetAt) {
        m.resetAt = undefined;
        m.avatar?.setExpression("neutral", 0, EXPRESSION_FADE);
        m.avatar?.lookAt(null);
      }
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

  /** Fires the current line's cues that are due at `t` seconds into it. */
  private fireDue(t: number): void {
    const p = this.performance;
    if (!p || t < 0) return;
    while (p.cues.length && p.cues[0].time !== "end" && p.cues[0].time <= t) this.fire(p.speaker, p.cues.shift()!.cue);
  }

  /** Fires whatever the current line still has, "end" cues included, and ends it. */
  private firePending(): void {
    const p = this.performance;
    this.performance = null;
    for (const { cue } of p?.cues ?? []) this.fire(p!.speaker, cue);
  }

  private fire(speakerId: string, cue: Cue): void {
    const m = this.member(speakerId);
    const avatar = m?.avatar;
    if (!m || !avatar) return;
    if (cue.expression) avatar.setExpression(modelName(cue.expression, m.spec.names), 1, EXPRESSION_FADE);
    if (cue.gesture) avatar.gesture(modelName(cue.gesture, m.spec.names));
    if (cue.lookAt !== undefined) {
      const target = cue.lookAt === "camera" ? undefined : this.member(cue.lookAt);
      avatar.lookAt(target && target !== m ? this.direction(m, target) : null);
    }
  }

  private member(id: string): Member | undefined {
    return this.members.find((m) => m.spec.id === id);
  }

  /** Where `to`'s slot is as seen from `from`'s: further slots, further to the side. */
  private direction(from: Member, to: Member): LookTarget {
    const d = this.members.indexOf(to) - this.members.indexOf(from);
    return { x: Math.max(-1, Math.min(1, d * 0.6)), y: 0 };
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
