import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LogEntry } from "../stage/ConversationLog";
import type { Line, LineDraft, LineEvent, QueuePosition, Scene } from "../stage/Line";
import type { VoiceParams } from "../voice/params";
import type { AudioQuery } from "../voice/timeline";
import type { LineSink, TextSource } from "./TextSource";

/** Mirrors `LineRequest` in src-tauri/src/api.rs. */
interface LineRequest {
  text: string;
  character?: string;
  speaker?: number;
  voice?: VoiceParams;
  audioQuery?: AudioQuery;
  direction?: boolean;
}

/** Mirrors `Submission` in src-tauri/src/api.rs. */
interface Submission {
  /** Null for a single `/speak` line. */
  sceneId: string | null;
  placement: "append" | "next";
  lines: (LineRequest & { id: string })[];
}

/** Mirrors `StageEvent` in src-tauri/src/stage.rs. */
type StageEvent =
  | ({ type: "line" } & Omit<Line, "id" | "voice" | "audioQuery" | "speaker" | "direction"> & {
        lineId: string;
        state: LineEvent["state"];
        error?: string;
      })
  | ({ type: "log" } & LogEntry);

export interface SceneQueue {
  enqueueScene(scene: Scene, position: QueuePosition): Line[];
  cancelScene(sceneId: string): void;
}

/** Lines and scenes posted to the local API (forwarded by Rust). */
export class LocalApiSource implements TextSource {
  readonly name = "api";
  private unlisten: UnlistenFn[] = [];

  constructor(private readonly scenes: SceneQueue) {}

  async start(sink: LineSink): Promise<void> {
    this.unlisten.push(
      await listen<Submission>("stage-submit", ({ payload }) => this.submit(payload, sink)),
      await listen<string>("stage-cancel-scene", ({ payload }) => this.scenes.cancelScene(payload)),
    );
    // Until this, the API answers 503 instead of queueing into the void.
    await invoke("stage_ready");
  }

  stop(): void {
    for (const unlisten of this.unlisten) unlisten();
    this.unlisten = [];
  }

  private submit({ sceneId, placement, lines }: Submission, sink: LineSink): void {
    if (sceneId === null) {
      for (const line of lines) sink({ ...line, source: this.name } satisfies LineDraft);
      return;
    }
    const position = placement === "next" ? "next" : "end";
    this.scenes.enqueueScene({ id: sceneId, source: this.name, lines }, position);
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Tells the API what happened to a line, for `GET /scenes/{id}` and `GET /events`. */
export function reportLineEvent({ line, state, error }: LineEvent): void {
  const event: StageEvent = {
    type: "line",
    lineId: line.id,
    character: line.character,
    text: line.text,
    source: line.source,
    state,
    ...(line.sceneId !== undefined && { sceneId: line.sceneId }),
    ...(error !== undefined && { error: errorText(error) }),
  };
  invoke("stage_event", { event }).catch((e) => console.error("stage_event", e));
}

/** Tells the API a line was added to the conversation log. */
export function reportLogEntry(entry: LogEntry): void {
  const event: StageEvent = { type: "log", ...entry };
  invoke("stage_event", { event }).catch((e) => console.error("stage_event", e));
}
