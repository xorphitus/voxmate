import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TextSource, UtteranceSink } from "./TextSource";

/** Mirrors `SpeakRequest` in src-tauri/src/api.rs. */
interface SpeakRequest {
  text: string;
  speaker?: number;
}

/** Utterances posted to `POST /speak` on the local API (forwarded by Rust). */
export class LocalApiSource implements TextSource {
  readonly name = "api";
  private unlisten: UnlistenFn | null = null;

  async start(sink: UtteranceSink): Promise<void> {
    this.unlisten = await listen<SpeakRequest>("speak-request", ({ payload }) => {
      sink({ text: payload.text, speaker: payload.speaker, source: this.name });
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
  }
}
