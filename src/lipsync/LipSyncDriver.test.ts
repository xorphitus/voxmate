import { describe, expect, it } from "vitest";
import { LipSyncDriver, type PlaybackClock } from "./LipSyncDriver";
import type { Segment } from "../voice/timeline";

const timeline: Segment[] = [
  { start: 0, end: 0.1, vowel: null, weight: 0 },
  { start: 0.1, end: 0.5, vowel: "a", weight: 1 },
  { start: 0.5, end: 0.9, vowel: "i", weight: 1 },
];

function fakeClock(): PlaybackClock & { currentTime: number; level: number } {
  return {
    currentTime: -1,
    level: 0.1,
    rms() {
      return this.level;
    },
  };
}

function run(driver: LipSyncDriver, clock: { currentTime: number }, from: number, to: number) {
  const dt = 1 / 60;
  for (let t = from; t < to; t += dt) {
    clock.currentTime = t;
    driver.tick(dt, null);
  }
}

describe("LipSyncDriver", () => {
  it("stays closed while idle", () => {
    const clock = fakeClock();
    const driver = new LipSyncDriver(clock);
    driver.setTimeline(timeline);
    driver.tick(1 / 60, null);
    expect(driver.state.openness).toBe(0);
    expect(driver.state.weights.a).toBe(0);
  });

  it("converges on the active vowel", () => {
    const clock = fakeClock();
    const driver = new LipSyncDriver(clock);
    driver.setTimeline(timeline);
    run(driver, clock, 0, 0.45);
    expect(driver.state.weights.a).toBeGreaterThan(0.95);
    expect(driver.state.weights.i).toBeLessThan(0.01);
    expect(driver.state.openness).toBeGreaterThan(0.9);

    run(driver, clock, 0.5, 0.85);
    expect(driver.state.weights.i).toBeGreaterThan(0.95);
    expect(driver.state.weights.a).toBeLessThan(0.01);
  });

  it("blends rather than jumps", () => {
    const clock = fakeClock();
    const driver = new LipSyncDriver(clock);
    driver.setTimeline(timeline);
    clock.currentTime = 0.2;
    driver.tick(1 / 60, null);
    expect(driver.state.weights.a).toBeGreaterThan(0.1);
    expect(driver.state.weights.a).toBeLessThan(0.5);
  });

  it("opens less for quieter passages", () => {
    const clock = fakeClock();
    const driver = new LipSyncDriver(clock);
    driver.setTimeline(timeline);
    run(driver, clock, 0.1, 0.3);
    const loud = driver.state.openness;
    clock.level = 0.02;
    run(driver, clock, 0.3, 0.5);
    expect(driver.state.openness).toBeLessThan(loud * 0.6);
  });

  it("closes again after the timeline is cleared", () => {
    const clock = fakeClock();
    const driver = new LipSyncDriver(clock);
    driver.setTimeline(timeline);
    run(driver, clock, 0.1, 0.4);
    driver.clear();
    run(driver, clock, 0.4, 0.8);
    expect(driver.state.weights.a).toBeLessThan(0.01);
    expect(driver.state.openness).toBeLessThan(0.01);
  });
});
