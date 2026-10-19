import { describe, expect, it } from "vitest";
import { modelName, scheduleCues } from "./cues";
import { gestureDuration, gestureOffset } from "./gestures";

describe("scheduleCues", () => {
  it("resolves times and orders cues, with the emotion first", () => {
    const cues = scheduleCues(
      [
        { at: "end", gesture: "nod" },
        { at: { phrase: 1 }, expression: "surprised" },
        { at: 0.2, lookAt: "metan" },
        { at: { phrase: 9 }, gesture: "tilt" },
      ],
      "happy",
      [0.1, 0.8],
    );
    expect(cues.map((c) => c.time)).toEqual([0, 0.2, 0.8, "end", "end"]);
    expect(cues[0].cue).toEqual({ at: "start", expression: "happy" });
    expect(cues[3].cue.gesture).toBe("nod");
  });

  it("handles no cues", () => {
    expect(scheduleCues(undefined, undefined, [])).toEqual([]);
  });
});

describe("modelName", () => {
  it("maps portable names, passes raw ones through", () => {
    expect(modelName("happy", { happy: "f01" })).toBe("f01");
    expect(modelName("f02", { happy: "f01" })).toBe("f02");
    expect(modelName("nod", undefined)).toBe("nod");
  });
});

describe("gestureOffset", () => {
  it("starts and ends at rest and moves in between", () => {
    for (const name of ["nod", "shake", "tilt"]) {
      const d = gestureDuration(name)!;
      const start = gestureOffset(name, 0)!;
      expect(Math.abs(start.pitch) + Math.abs(start.yaw) + Math.abs(start.roll)).toBeLessThan(1e-9);
      const mid = gestureOffset(name, d * 0.3)!;
      expect(Math.abs(mid.pitch) + Math.abs(mid.yaw) + Math.abs(mid.roll)).toBeGreaterThan(0.1);
      expect(gestureOffset(name, d)).toBeNull();
    }
    expect(gestureOffset("wave", 0.1)).toBeNull();
  });
});
