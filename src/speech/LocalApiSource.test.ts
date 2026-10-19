import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const invoke = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { LocalApiSource, reportLineEvent } = await import("./LocalApiSource");

function setup() {
  const scenes = { enqueueScene: vi.fn(() => []), cancelScene: vi.fn() };
  const sink = vi.fn(() => null);
  const source = new LocalApiSource(scenes);
  return { scenes, sink, source, emit: (name: string, payload: unknown) => handlers.get(name)!({ payload }) };
}

describe("LocalApiSource", () => {
  beforeEach(() => {
    handlers.clear();
    invoke.mockClear();
  });

  it("tells Rust it is ready once listening", async () => {
    const { source, sink } = setup();
    await source.start(sink);
    expect(handlers.has("stage-submit")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("stage_ready");
  });

  it("queues a /speak line with its id", async () => {
    const { source, sink, emit } = setup();
    await source.start(sink);
    emit("stage-submit", { sceneId: null, placement: "append", lines: [{ id: "l1", text: "hi", speaker: 1 }] });
    expect(sink).toHaveBeenCalledWith({ id: "l1", text: "hi", speaker: 1, source: "api" });
  });

  it("queues a scene together, at the requested place", async () => {
    const { source, sink, scenes, emit } = setup();
    await source.start(sink);
    const lines = [
      { id: "a", text: "one", character: "zunda" },
      { id: "b", text: "two", character: "metan" },
    ];
    emit("stage-submit", { sceneId: "s1", placement: "next", lines });
    expect(scenes.enqueueScene).toHaveBeenCalledWith({ id: "s1", source: "api", lines }, "next");
    expect(sink).not.toHaveBeenCalled();
  });

  it("cancels scenes", async () => {
    const { source, sink, scenes, emit } = setup();
    await source.start(sink);
    emit("stage-cancel-scene", "s1");
    expect(scenes.cancelScene).toHaveBeenCalledWith("s1");
  });
});

describe("reportLineEvent", () => {
  it("sends the event in the shape stage.rs expects", () => {
    reportLineEvent({
      line: { id: "l1", character: "zunda", text: "hi", source: "api", sceneId: "s1", voice: { speed: 2 } },
      state: "failed",
      error: new Error("boom"),
    });
    expect(invoke).toHaveBeenCalledWith("stage_event", {
      event: {
        type: "line",
        lineId: "l1",
        character: "zunda",
        text: "hi",
        source: "api",
        state: "failed",
        sceneId: "s1",
        error: "boom",
      },
    });
  });
});
