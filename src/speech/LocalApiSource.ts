import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TextSource, LineSink } from "./TextSource";

/** Mirrors `SpeakRequest` in src-tauri/src/api.rs. */
interface SpeakRequest {
  text: string;
  character?: string;
  speaker?: number;
}

/** Lines posted to `POST /speak` on the local API (forwarded by Rust). */
export class LocalApiSource implements TextSource {
  readonly name = "api";
  private unlisten: UnlistenFn | null = null;

  async start(sink: LineSink): Promise<void> {
    this.unlisten = await listen<SpeakRequest>("speak-request", ({ payload }) => {
      sink({ text: payload.text, character: payload.character, speaker: payload.speaker, source: this.name });
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
  }
}
