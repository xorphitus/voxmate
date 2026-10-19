import { invoke } from "@tauri-apps/api/core";
import type { VoiceParams } from "./params";
import type { AudioQuery } from "./timeline";

export interface SpeakerStyle {
  name: string;
  id: number;
}

export interface Speaker {
  name: string;
  speaker_uuid: string;
  styles: SpeakerStyle[];
}

export interface Synthesis {
  query: AudioQuery;
  wav: ArrayBuffer;
}

export function fetchSpeakers(): Promise<Speaker[]> {
  return invoke<Speaker[]>("voicevox_speakers");
}

export function setVoicevoxUrl(url: string): Promise<void> {
  return invoke("set_voicevox_url", { url });
}

/** Synthesizes `query` when given (an edited `audio_query`), or a fresh query for `text`. */
export async function synthesize(
  text: string,
  speaker: number,
  voice: VoiceParams = {},
  query?: AudioQuery,
): Promise<Synthesis> {
  const packed = await invoke<ArrayBuffer>("voicevox_synthesize", { text, speaker, voice, query: query ?? null });
  return unpack(packed);
}

/** Inverse of `Synthesis::pack` in src-tauri/src/voicevox.rs. */
export function unpack(packed: ArrayBuffer): Synthesis {
  if (packed.byteLength < 4) throw new Error("synthesis payload too short");
  const jsonLength = new DataView(packed).getUint32(0, true);
  const wavStart = 4 + jsonLength;
  if (wavStart > packed.byteLength) throw new Error("synthesis payload truncated");
  const json = new TextDecoder().decode(new Uint8Array(packed, 4, jsonLength));
  return { query: JSON.parse(json) as AudioQuery, wav: packed.slice(wavStart) };
}
