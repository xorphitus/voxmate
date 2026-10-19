import { Channel, invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * A chat backend. Kept to one streaming call so other runtimes or agent
 * harnesses can be wrapped without touching the speech side.
 */
export interface LlmProvider {
  /** Yields reply text as it streams. Aborting the signal ends the stream quietly. */
  chat(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}

/** Mirrors `LlmEvent` in src-tauri/src/lib.rs. */
type LlmEvent = { event: "delta"; data: { text: string } } | { event: "done" } | { event: "error"; data: { message: string } };

export interface OpenAiCompatibleConfig {
  /** Server root, without `/v1`; e.g. llama-swap's http://127.0.0.1:8080. */
  url: string;
  /** Model name; llama-swap swaps in the matching model. */
  model: string;
}

let nextRequestId = 1;

/**
 * llama-swap and anything else speaking `/v1/chat/completions` (Ollama,
 * LM Studio, vLLM...). The HTTP request runs in Rust (src-tauri/src/llm.rs).
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly config: () => OpenAiCompatibleConfig) {}

  async *chat(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    if (signal.aborted) return;
    const id = nextRequestId++;
    const pending: string[] = [];
    let finished = false;
    let error: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };

    const channel = new Channel<LlmEvent>();
    channel.onmessage = (e) => {
      if (e.event === "delta") pending.push(e.data.text);
      else {
        if (e.event === "error") error = new Error(e.data.message);
        finished = true;
      }
      notify();
    };
    const onAbort = () => {
      void invoke("llm_cancel", { id });
      notify();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const { url, model } = this.config();
      await invoke("llm_chat", { id, url, model, messages, onEvent: channel });
      for (;;) {
        if (signal.aborted) return;
        if (pending.length) {
          yield pending.shift()!;
          continue;
        }
        if (finished) {
          if (error) throw error;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Aborts every generation running in Rust, including any whose stream was already dropped. */
export function cancelAllGenerations(): void {
  void invoke("llm_cancel_all");
}
