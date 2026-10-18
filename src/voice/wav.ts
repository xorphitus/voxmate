/**
 * Tiny RIFF/WAVE decoder for the 16-bit PCM VOICEVOX produces.
 *
 * Decoding ourselves avoids depending on the webview's codec stack
 * (GStreamer on WebKitGTK) just to read uncompressed PCM.
 */

export interface PcmAudio {
  sampleRate: number;
  /** One Float32Array per channel, samples in -1..1. */
  channels: Float32Array<ArrayBuffer>[];
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function parseWav(buffer: ArrayBuffer): PcmAudio {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let format: { channels: number; sampleRate: number; bits: number; tag: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = fourcc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      format = {
        tag: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAVE data chunk before fmt chunk");
      if (format.tag !== 1 || format.bits !== 16) {
        throw new Error(`unsupported WAVE format (tag ${format.tag}, ${format.bits} bit)`);
      }
      const n = format.channels;
      const available = Math.min(size, buffer.byteLength - body);
      const frames = Math.floor(available / (2 * n));
      const channels = Array.from({ length: n }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < n; c++) {
          channels[c][f] = view.getInt16(body + (f * n + c) * 2, true) / 32768;
        }
      }
      return { sampleRate: format.sampleRate, channels };
    }
    // Chunks are padded to even sizes.
    offset = body + size + (size & 1);
  }
  throw new Error("WAVE file has no data chunk");
}
