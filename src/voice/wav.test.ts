import { describe, expect, it } from "vitest";
import { parseWav } from "./wav";
import { unpack } from "./voicevox";

function makeWav(samples: number[], channels = 1, sampleRate = 24000, extraChunk = false): ArrayBuffer {
  const dataSize = samples.length * 2;
  const extra = extraChunk ? 8 + 3 + 1 : 0; // odd-sized chunk + pad byte
  const buf = new ArrayBuffer(44 + extra + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, buf.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  let o = 36;
  if (extraChunk) {
    str(o, "LIST");
    v.setUint32(o + 4, 3, true);
    o += 12;
  }
  str(o, "data");
  v.setUint32(o + 4, dataSize, true);
  samples.forEach((s, i) => v.setInt16(o + 8 + i * 2, s, true));
  return buf;
}

describe("parseWav", () => {
  it("decodes mono 16-bit PCM", () => {
    const pcm = parseWav(makeWav([0, 16384, -32768, 32767]));
    expect(pcm.sampleRate).toBe(24000);
    expect(pcm.channels).toHaveLength(1);
    expect(Array.from(pcm.channels[0])).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it("deinterleaves stereo", () => {
    const pcm = parseWav(makeWav([1, -1, 2, -2], 2, 48000));
    expect(pcm.sampleRate).toBe(48000);
    expect(pcm.channels[0].length).toBe(2);
    expect(pcm.channels[1][1]).toBeCloseTo(-2 / 32768);
  });

  it("skips unknown, odd-sized chunks", () => {
    const pcm = parseWav(makeWav([100, 200], 1, 24000, true));
    expect(pcm.channels[0].length).toBe(2);
  });

  it("rejects non-WAVE input", () => {
    expect(() => parseWav(new ArrayBuffer(4))).toThrow(/RIFF/);
  });
});

describe("unpack", () => {
  it("splits the query JSON from the wav bytes", () => {
    const json = new TextEncoder().encode(JSON.stringify({ kana: "テスト" }));
    const packed = new Uint8Array(4 + json.length + 3);
    new DataView(packed.buffer).setUint32(0, json.length, true);
    packed.set(json, 4);
    packed.set([7, 8, 9], 4 + json.length);

    const out = unpack(packed.buffer);
    expect(out.query).toEqual({ kana: "テスト" });
    expect(Array.from(new Uint8Array(out.wav))).toEqual([7, 8, 9]);
  });

  it("rejects truncated payloads", () => {
    const packed = new Uint8Array(6);
    new DataView(packed.buffer).setUint32(0, 100, true);
    expect(() => unpack(packed.buffer)).toThrow(/truncated/);
  });
});
