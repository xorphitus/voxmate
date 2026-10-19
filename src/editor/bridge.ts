import type { LineState } from "../stage/Line";

/**
 * Events between the scene editor window and the stage window, which owns
 * playback. The editor picks the scene and line ids, so it can match the
 * playback events to its lines.
 */
export const EDITOR_PLAY = "editor-play";
export const EDITOR_STOP = "editor-stop";
/** Every line event of the stage, for the editor to highlight its lines. */
export const STAGE_LINE = "stage-line";

export interface EditorPlay {
  sceneId: string;
  /** `LineRequest` JSON (see scene.ts) with `id`s. */
  lines: (Record<string, unknown> & { id: string })[];
}

export interface EditorStop {
  sceneId: string;
}

export interface StageLine {
  lineId: string;
  sceneId?: string;
  state: LineState;
  error?: string;
}
