import { describe, expect, it, vi } from "vitest";
import type { Segment } from "../voice/timeline";
import type { Avatar, VowelWeights } from "./Avatar";
import { planStage, type Slot, StageView } from "./StageView";

function fakeAvatar(path: string) {
  const mouth: { weights: VowelWeights; openness: number }[] = [];
  const avatar = {
    kind: "vrm" as const,
    path,
    mouth,
    load: vi.fn(async () => {}),
    setMouth: (weights: VowelWeights, openness: number) => mouth.push({ weights: { ...weights }, openness }),
    update: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  return avatar satisfies Avatar;
}

function setup() {
  const slots: { label: string | null; error: boolean; place: [number, number]; removed: boolean }[] = [];
  const avatars: ReturnType<typeof fakeAvatar>[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let deferLoads = false;
  const clock = { currentTime: 0.15, rms: () => 0.3 };
  const view = new StageView({
    clock,
    createSlot: (): Slot => {
      const slot = { label: null as string | null, error: false, place: [0, 0] as [number, number], removed: false };
      slots.push(slot);
      return {
        container: {} as HTMLElement,
        place: (i, n) => (slot.place = [i, n]),
        setLabel: (text, error = false) => Object.assign(slot, { label: text, error }),
        remove: () => (slot.removed = true),
      };
    },
    loadAvatar: async (path) => {
      if (path.includes("broken")) throw new Error("bad file");
      if (deferLoads) await new Promise<void>((resolve, reject) => pending.set(path, { resolve, reject }));
      const avatar = fakeAvatar(path);
      avatars.push(avatar);
      return avatar;
    },
  });
  return { view, slots, avatars, pending, clock, defer: () => (deferLoads = true) };
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];

const timeline: Segment[] = [{ start: 0, end: 1, vowel: "a", weight: 1 }];

describe("planStage", () => {
  it("adds, removes and reloads by id", () => {
    const plan = planStage(
      [
        { id: "a", modelPath: "/a.vrm" },
        { id: "b", modelPath: "/b.vrm" },
      ],
      [
        { id: "b", name: "B", modelPath: "/b2.vrm" },
        { id: "c", name: "C", modelPath: null },
      ],
    );
    expect(plan.remove).toEqual(["a"]);
    expect(plan.add.map((m) => m.id)).toEqual(["c"]);
    expect(plan.reload.map((m) => m.id)).toEqual(["b"]);
  });
});

describe("StageView", () => {
  it("shows several members side by side, mixing kinds of models", async () => {
    const { view, slots, avatars } = setup();
    await view.sync([
      { id: "zunda", name: "ずんだもん", modelPath: "/m/zunda.vrm" },
      { id: "hiyori", name: "ひより", modelPath: "/m/hiyori.model3.json" },
    ]);
    expect(slots.map((s) => s.place)).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(avatars.map((a) => a.path)).toEqual(["/m/zunda.vrm", "/m/hiyori.model3.json"]);
    expect(view.state.map((m) => m.status)).toEqual(["loaded", "loaded"]);
  });

  it("moves only the speaker's mouth", async () => {
    const { view, avatars } = setup();
    await view.sync([
      { id: "zunda", name: "Z", modelPath: "/z.vrm" },
      { id: "metan", name: "M", modelPath: "/m.vrm" },
    ]);
    view.speak("metan", timeline);
    for (let i = 0; i < 10; i++) view.tick(1 / 60);
    const [zunda, metan] = avatars;
    expect(last(zunda.mouth).openness).toBe(0);
    expect(last(metan.mouth).openness).toBeGreaterThan(0.3);
    expect(last(metan.mouth).weights.a).toBeGreaterThan(0.5);

    view.silence();
    for (let i = 0; i < 60; i++) view.tick(1 / 60);
    expect(last(metan.mouth).openness).toBeLessThan(0.01);
  });

  it("labels members without a model or whose model failed", async () => {
    const { view, slots } = setup();
    await view.sync([
      { id: "a", name: "A", modelPath: null },
      { id: "b", name: "B", modelPath: "/broken.vrm" },
    ]);
    expect(slots[0].label).toBe("A: no model");
    expect(slots[1]).toMatchObject({ label: "B: could not load the model (bad file)", error: true });
    expect(view.state[1]).toMatchObject({ status: "error", error: "bad file" });
  });

  it("removes members and reorders the rest", async () => {
    const { view, slots, avatars } = setup();
    await view.sync([
      { id: "a", name: "A", modelPath: "/a.vrm" },
      { id: "b", name: "B", modelPath: "/b.vrm" },
      { id: "c", name: "C", modelPath: "/c.vrm" },
    ]);
    await view.sync([
      { id: "c", name: "C", modelPath: "/c.vrm" },
      { id: "a", name: "A", modelPath: "/a.vrm" },
    ]);
    expect(slots[1].removed).toBe(true);
    expect(avatars[1].dispose).toHaveBeenCalled();
    expect(slots[2].place).toEqual([0, 2]);
    expect(slots[0].place).toEqual([1, 2]);
    expect(avatars).toHaveLength(3);
  });

  it("reloads a member whose model changed, keeping the newest", async () => {
    const { view, avatars, pending, defer } = setup();
    await view.sync([{ id: "a", name: "A", modelPath: "/1.vrm" }]);
    defer();
    const second = view.sync([{ id: "a", name: "A", modelPath: "/2.vrm" }]);
    const third = view.sync([{ id: "a", name: "A", modelPath: "/3.vrm" }]);
    pending.get("/3.vrm")!.resolve();
    await third;
    pending.get("/2.vrm")!.resolve();
    await second;
    const byPath = (p: string) => avatars.find((a) => a.path === p)!;
    const [first, two, three] = ["/1.vrm", "/2.vrm", "/3.vrm"].map(byPath);
    expect(first.dispose).toHaveBeenCalled();
    expect(two.dispose).toHaveBeenCalled();
    expect(three.dispose).not.toHaveBeenCalled();
  });

  it("drops a model that finishes loading after its member left", async () => {
    const { view, avatars, pending, defer, slots } = setup();
    defer();
    const loading = view.sync([{ id: "a", name: "A", modelPath: "/a.vrm" }]);
    expect(slots[0].label).toBe("A: loading…");
    await view.sync([]);
    pending.get("/a.vrm")!.resolve();
    await loading;
    expect(avatars[0].dispose).toHaveBeenCalled();
  });
});
