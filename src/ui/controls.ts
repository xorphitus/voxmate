import type { Settings } from "../config";
import type { TextSource, UtteranceSink } from "../speech/TextSource";
import type { Speaker } from "../voice/voicevox";
import type { ThemePreference } from "./theme";

export interface ControlHandlers {
  stop(): void;
  /** Send the text to the LLM; its reply is spoken. */
  ask(text: string): void;
  loadModel(): void;
  refreshSpeakers(): void;
  /** Called after the user edits a setting; the handler persists/applies it. */
  change<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

/** The control panel. Also the "ui" TextSource: submitted text is spoken. */
export class Controls implements TextSource {
  readonly name = "ui";
  private sink: UtteranceSink | null = null;

  private readonly form = $<HTMLFormElement>("say");
  private readonly text = $<HTMLTextAreaElement>("text");
  private readonly status = $<HTMLParagraphElement>("status");
  private readonly queueInfo = $<HTMLSpanElement>("queue-info");
  private readonly speaker = $<HTMLSelectElement>("speaker");
  private readonly voicevoxUrl = $<HTMLInputElement>("voicevox-url");
  private readonly volume = $<HTMLInputElement>("volume");
  private readonly alwaysOnTop = $<HTMLInputElement>("always-on-top");
  private readonly transparent = $<HTMLInputElement>("transparent");
  private readonly theme = $<HTMLSelectElement>("theme");
  private readonly llmUrl = $<HTMLInputElement>("llm-url");
  private readonly llmModel = $<HTMLInputElement>("llm-model");
  private readonly llmSystemPrompt = $<HTMLTextAreaElement>("llm-system-prompt");
  private readonly llmHistory = $<HTMLInputElement>("llm-history");
  private readonly apiEnabled = $<HTMLInputElement>("api-enabled");
  private readonly apiPort = $<HTMLInputElement>("api-port");
  private readonly apiStatus = $<HTMLParagraphElement>("api-status");
  private readonly placeholder = $<HTMLDivElement>("placeholder");
  private readonly placeholderTitle = $<HTMLParagraphElement>("placeholder-title");
  private readonly placeholderHint = $<HTMLParagraphElement>("placeholder-hint");
  private readonly placeholderLoad = $<HTMLButtonElement>("placeholder-load");

  constructor(settings: Settings, handlers: ControlHandlers) {
    this.voicevoxUrl.value = settings.voicevoxUrl;
    this.volume.value = String(settings.volume);
    this.alwaysOnTop.checked = settings.alwaysOnTop;
    this.transparent.checked = settings.transparent;
    this.theme.value = settings.theme;
    this.llmUrl.value = settings.llmUrl;
    this.llmModel.value = settings.llmModel;
    this.llmSystemPrompt.value = settings.llmSystemPrompt;
    this.llmHistory.value = String(settings.llmHistory);
    this.apiEnabled.checked = settings.apiEnabled;
    this.apiPort.value = String(settings.apiPort);
    document.body.classList.toggle("transparent", settings.transparent);

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
    this.text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.submit();
      }
    });
    $("stop").addEventListener("click", () => handlers.stop());
    $("ask").addEventListener("click", () => {
      const text = this.text.value.trim();
      if (!text) return;
      handlers.ask(text);
      this.text.value = "";
    });
    $("load-model").addEventListener("click", () => handlers.loadModel());
    this.placeholderLoad.addEventListener("click", () => handlers.loadModel());
    $("refresh-speakers").addEventListener("click", () => handlers.refreshSpeakers());

    this.speaker.addEventListener("change", () => handlers.change("speaker", Number(this.speaker.value)));
    $("voicevox-apply").addEventListener("click", () =>
      handlers.change("voicevoxUrl", this.voicevoxUrl.value.trim()),
    );
    this.volume.addEventListener("input", () => handlers.change("volume", Number(this.volume.value)));
    this.alwaysOnTop.addEventListener("change", () => handlers.change("alwaysOnTop", this.alwaysOnTop.checked));
    this.transparent.addEventListener("change", () => handlers.change("transparent", this.transparent.checked));
    this.theme.addEventListener("change", () => handlers.change("theme", this.theme.value as ThemePreference));
    this.llmUrl.addEventListener("change", () => handlers.change("llmUrl", this.llmUrl.value.trim()));
    this.llmModel.addEventListener("change", () => handlers.change("llmModel", this.llmModel.value.trim()));
    this.llmSystemPrompt.addEventListener("change", () =>
      handlers.change("llmSystemPrompt", this.llmSystemPrompt.value),
    );
    this.llmHistory.addEventListener("change", () => {
      const count = Number(this.llmHistory.value);
      if (Number.isInteger(count) && count >= 0 && count <= 200) handlers.change("llmHistory", count);
      else this.error("History must be between 0 and 200 messages.");
    });
    this.apiEnabled.addEventListener("change", () => handlers.change("apiEnabled", this.apiEnabled.checked));
    this.apiPort.addEventListener("change", () => {
      const port = Number(this.apiPort.value);
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) handlers.change("apiPort", port);
      else this.error("API port must be between 1024 and 65535.");
    });

    const panel = $("panel");
    const toggle = $("toggle-panel");
    toggle.addEventListener("click", () => {
      const hidden = panel.classList.toggle("hidden");
      toggle.setAttribute("aria-expanded", String(!hidden));
    });
    // Keep the empty state clear of the panel, which grows when settings open.
    // A hidden panel has zero height, so it also fires on toggle.
    new ResizeObserver(() => {
      const height = panel.offsetHeight ? panel.offsetHeight + 8 : 0;
      document.documentElement.style.setProperty("--panel-height", `${height}px`);
    }).observe(panel);
  }

  start(sink: UtteranceSink): void {
    this.sink = sink;
  }

  stop(): void {
    this.sink = null;
  }

  private submit(): void {
    const text = this.text.value.trim();
    if (!text || !this.sink) return;
    this.sink({ text, source: this.name });
    this.text.value = "";
  }

  setSpeakers(speakers: Speaker[], selected: number): void {
    this.speaker.replaceChildren(
      ...speakers.flatMap((s) =>
        s.styles.map((style) => new Option(`${s.name}（${style.name}）`, String(style.id), false, style.id === selected)),
      ),
    );
  }

  setQueueState(speaking: string | null, pending: number): void {
    const parts = [];
    if (speaking) parts.push("speaking…");
    if (pending) parts.push(`${pending} queued`);
    this.queueInfo.textContent = parts.join(", ");
  }

  setApiStatus(text: string): void {
    this.apiStatus.textContent = text;
  }

  /** `loading` names the file being loaded; it only shows while no model is on stage. */
  setModelState(state: "empty" | "loading" | "loaded", file?: string): void {
    this.placeholder.hidden = state === "loaded";
    const loading = state === "loading";
    this.placeholderTitle.textContent = loading ? `Loading ${file ?? "model"}…` : "No model loaded.";
    this.placeholderHint.hidden = loading;
    this.placeholderLoad.disabled = loading;
  }

  info(message: string): void {
    this.status.textContent = message;
    this.status.classList.remove("error");
  }

  error(message: string): void {
    this.status.textContent = message;
    this.status.classList.add("error");
  }
}
