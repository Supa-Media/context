import { describe, expect, test } from "@jest/globals";

/**
 * CUTTING PIECES OUT OF A RECORDING THAT IS STILL BEING WRITTEN.
 *
 * The arithmetic underneath the fix for the defect that ended meetings at the
 * lock screen. `capture/wav.ts` carries the argument; the short version is that
 * iOS refuses to *start* a recording from the background
 * (`AVAudioSessionErrorCodeCannotStartRecording`) while letting one that is
 * already running continue — so the recorder must be started once and never
 * stopped, and the twenty-second chunks have to come out of the growing file
 * instead of out of a stop/start cycle.
 *
 * Everything that can be got wrong here is silent. A header read from the wrong
 * offset, a slice cut mid-sample, a sample rate assumed rather than read: none
 * of them throws, none of them shows up on a screen, and all of them arrive as
 * a transcript full of words nobody said. So the checks are about *bytes*, and
 * the round trip at the end is the one that would catch a defect the individual
 * assertions let through.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const wav = require("../features/meetings/capture/wav") as typeof import("../features/meetings/capture/wav");
/* eslint-enable @typescript-eslint/no-require-imports */

const {
  alignToFrame,
  encodeBase64,
  frameBytes,
  parseWavHeader,
  pcmBytesForMs,
  pcmDurationMs,
  wavFile,
  WAV_HEADER_BYTES,
} = wav;

type PcmFormat = import("../features/meetings/capture/wav").PcmFormat;

const MONO_16K: PcmFormat = {
  dataOffset: WAV_HEADER_BYTES,
  sampleRate: 16_000,
  channels: 1,
  bitDepth: 16,
};

/** A byte pattern that makes an off-by-one visible. */
function ramp(length: number, from = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) out[index] = (from + index) % 256;
  return out;
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

/**
 * A WAVE header the way a recorder writes one, with optional junk chunks ahead
 * of `data` and a `data` length that is deliberately a lie.
 *
 * Both are the real conditions. CoreAudio is free to put `LIST` or `fact`
 * chunks before the samples, and the `data` length in a file that is still open
 * is whatever was true when the header was flushed — frequently zero.
 */
function header(options: {
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  audioFormat?: number;
  dataLength?: number;
  before?: { id: string; body: number[] }[];
} = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const bitDepth = options.bitDepth ?? 16;
  const blockAlign = (bitDepth / 8) * channels;

  const extra: number[] = [];
  for (const chunk of options.before ?? []) {
    extra.push(...ascii(chunk.id), ...u32le(chunk.body.length), ...chunk.body);
    if (chunk.body.length % 2 === 1) extra.push(0);
  }

  return Uint8Array.from([
    ...ascii("RIFF"),
    ...u32le(0),
    ...ascii("WAVE"),
    ...extra,
    ...ascii("fmt "),
    ...u32le(16),
    ...u16le(options.audioFormat ?? 1),
    ...u16le(channels),
    ...u32le(sampleRate),
    ...u32le(sampleRate * blockAlign),
    ...u16le(blockAlign),
    ...u16le(bitDepth),
    ...ascii("data"),
    ...u32le(options.dataLength ?? 0),
  ]);
}

describe("reading the format out of the file the recorder actually wrote", () => {
  test("a canonical header puts the samples at 44 and says what they are", () => {
    const format = parseWavHeader(header());
    expect(format).toEqual({
      dataOffset: WAV_HEADER_BYTES,
      sampleRate: 16_000,
      channels: 1,
      bitDepth: 16,
    });
  });

  test("a chunk ahead of the samples moves them, and is not assumed away", () => {
    /*
      THE ASSUMPTION THAT WOULD HAVE BEEN INVISIBLE.

      44 is the canonical header and not a guarantee: WAVE permits chunks before
      `data`, and CoreAudio writes what it likes. Slicing from a hard-coded 44
      would feed `LIST` bytes into the transcript's first slice and shift every
      sample after it — audible as a click, and never as an error.
    */
    const withList = header({ before: [{ id: "LIST", body: ascii("INFOISFT") }] });
    const format = parseWavHeader(withList);
    expect(format?.dataOffset).toBe(WAV_HEADER_BYTES + 8 + 8);

    // And the bytes at that offset really are the first samples.
    const file = Uint8Array.from([...withList, ...ramp(8)]);
    expect([...file.slice(format!.dataOffset, format!.dataOffset + 4)]).toEqual([0, 1, 2, 3]);
  });

  test("an odd-length chunk is followed by a pad byte, and the walk counts it", () => {
    const odd = header({ before: [{ id: "fact", body: [1, 2, 3] }] });
    expect(parseWavHeader(odd)?.dataOffset).toBe(WAV_HEADER_BYTES + 8 + 4);
  });

  test("a `data` length of zero is ignored rather than believed", () => {
    /*
      The lie that would cap every slice at nothing. A file being written
      carries whatever length was true when its header was flushed, so the
      file's real size is the only honest answer to "how much audio is there" —
      and this parser deliberately does not return the field at all, so no
      caller can reach for it by accident.
    */
    const format = parseWavHeader(header({ dataLength: 0 }));
    expect(format).not.toBeNull();
    expect(Object.keys(format!)).toEqual(["dataOffset", "sampleRate", "channels", "bitDepth"]);
  });

  test("the rate is read, never assumed, so a substituted one cannot pass as 16k", () => {
    /*
      `AVAudioRecorder` may not honour a requested sample rate. A slice labelled
      16 kHz that is really 44.1 kHz decodes at a third of the speed, which
      reads as a broken transcription model rather than a broken header — the
      most expensive kind of wrong.
    */
    expect(parseWavHeader(header({ sampleRate: 44_100, channels: 2 }))).toMatchObject({
      sampleRate: 44_100,
      channels: 2,
    });
  });

  test("WAVE_FORMAT_EXTENSIBLE is still linear PCM and is accepted", () => {
    expect(parseWavHeader(header({ audioFormat: 0xfffe }))).not.toBeNull();
  });

  test("anything that is not PCM in a WAVE wrapper is refused, not sliced", () => {
    // A compressed prefix is as unreadable as the `.m4a` this replaces, so it
    // is refused here rather than sent as audio nothing can decode.
    expect(parseWavHeader(header({ audioFormat: 0x11 }))).toBeNull();
  });

  test("a header that has not been written yet is `null`, not a guess", () => {
    expect(parseWavHeader(new Uint8Array(0))).toBeNull();
    expect(parseWavHeader(new Uint8Array(8))).toBeNull();
    expect(parseWavHeader(Uint8Array.from(ascii("NOTARIFFWAVE")))).toBeNull();
  });

  test("a header with no `data` chunk in it terminates rather than scanning audio", () => {
    /*
      Two ways this could hang or run away: a zero-length chunk that advances
      the cursor by nothing, and a file that is not a WAVE at all being scanned
      to the end of a hundred megabytes looking for four bytes that would occur
      in it by chance. The walk is bounded and refuses both.
    */
    const noData = Uint8Array.from([
      ...ascii("RIFF"), ...u32le(0), ...ascii("WAVE"),
      ...ascii("junk"), ...u32le(4), 0, 0, 0, 0,
    ]);
    expect(parseWavHeader(noData)).toBeNull();
  });
});

describe("cutting on a sample boundary", () => {
  test("a frame is one sample on every channel", () => {
    expect(frameBytes(MONO_16K)).toBe(2);
    expect(frameBytes({ ...MONO_16K, channels: 2 })).toBe(4);
    expect(frameBytes({ ...MONO_16K, bitDepth: 32, channels: 2 })).toBe(8);
  });

  test("a half-written sample is left for the next slice", () => {
    /*
      THE OFF-BY-ONE THAT COMPOUNDS.

      The recorder is writing while this reads, so the tail of a slice is as
      likely as not to be half a sample. Sending half a sample is noise in that
      slice — and, because the caller advances its offset by the length it took,
      it shifts every slice after it too. Cutting on a frame boundary is what
      makes a stream of slices reassemble into the recording.
    */
    expect(alignToFrame(101, MONO_16K)).toBe(100);
    expect(alignToFrame(100, MONO_16K)).toBe(100);
    expect(alignToFrame(3, { ...MONO_16K, channels: 2 })).toBe(0);
    expect(alignToFrame(0, MONO_16K)).toBe(0);
    expect(alignToFrame(-8, MONO_16K)).toBe(0);
  });

  test("length and duration agree in both directions", () => {
    // One second of 16 kHz mono 16-bit is 32,000 bytes, and the two converters
    // are each other's inverse on a frame boundary.
    expect(pcmBytesForMs(1000, MONO_16K)).toBe(32_000);
    expect(pcmDurationMs(32_000, MONO_16K)).toBe(1000);
    expect(pcmDurationMs(pcmBytesForMs(20_000, MONO_16K), MONO_16K)).toBe(20_000);
    expect(pcmBytesForMs(20_000, MONO_16K) % frameBytes(MONO_16K)).toBe(0);
  });

  test("a duration is never derived from a format that says nothing", () => {
    const broken: PcmFormat = { dataOffset: 44, sampleRate: 0, channels: 0, bitDepth: 0 };
    expect(pcmDurationMs(1024, broken)).toBe(0);
    expect(alignToFrame(1024, broken)).toBe(0);
  });
});

describe("a slice is a file something that never saw the meeting can decode", () => {
  test("the header describes the samples it is wrapped around", () => {
    const pcm = ramp(640);
    const file = wavFile(pcm, MONO_16K);

    expect(file.length).toBe(WAV_HEADER_BYTES + 640);
    expect([...file.slice(0, 4)]).toEqual(ascii("RIFF"));
    expect([...file.slice(8, 12)]).toEqual(ascii("WAVE"));
    expect([...file.slice(36, 40)]).toEqual(ascii("data"));
    // RIFF size is everything after the first 8 bytes; `data` size is the audio.
    expect([...file.slice(4, 8)]).toEqual(u32le(36 + 640));
    expect([...file.slice(40, 44)]).toEqual(u32le(640));
    // Byte rate and block align are derived, not copied, so they cannot drift.
    expect([...file.slice(24, 28)]).toEqual(u32le(16_000));
    expect([...file.slice(28, 32)]).toEqual(u32le(32_000));
    expect([...file.slice(32, 34)]).toEqual(u16le(2));
    expect([...file.slice(WAV_HEADER_BYTES)]).toEqual([...pcm]);
  });

  test("the format travels with the slice rather than being re-asserted", () => {
    const file = wavFile(ramp(8), { ...MONO_16K, sampleRate: 44_100, channels: 2 });
    expect([...file.slice(22, 24)]).toEqual(u16le(2));
    expect([...file.slice(24, 28)]).toEqual(u32le(44_100));
    expect([...file.slice(28, 32)]).toEqual(u32le(44_100 * 4));
  });

  test("a slice out of the middle of a recording round-trips byte for byte", () => {
    /*
      THE CHECK THAT WOULD CATCH WHAT THE OTHERS LET THROUGH.

      A whole recording, read the way the recorder will be read: parse the
      header once, then take frame-aligned windows and wrap each one. What
      comes out of the slices, concatenated, must be exactly the samples that
      went in — no byte dropped between windows, none repeated, and none of the
      header leaking into the first one.
    */
    const samples = ramp(32_000 * 3 + 7, 17);
    const file = Uint8Array.from([...header(), ...samples]);

    const format = parseWavHeader(file);
    expect(format).not.toBeNull();

    const window = pcmBytesForMs(20_000, format!);
    const collected: number[] = [];
    let read = format!.dataOffset;
    while (read < file.length) {
      const take = alignToFrame(Math.min(window, file.length - read), format!);
      if (take === 0) break;
      const slice = wavFile(file.slice(read, read + take), format!);
      expect(parseWavHeader(slice)).toMatchObject({ dataOffset: WAV_HEADER_BYTES });
      collected.push(...slice.slice(WAV_HEADER_BYTES));
      read += take;
    }

    // The odd trailing byte is a half sample and is deliberately left behind.
    expect(collected).toEqual([...samples.slice(0, samples.length - 1)]);
    expect(file.length - read).toBe(1);
  });
});

describe("base64 without a Buffer and without a stack overflow", () => {
  test("the padding cases are the ones that are wrong in the wild", () => {
    expect(encodeBase64(new Uint8Array(0))).toBe("");
    expect(encodeBase64(Uint8Array.from([77]))).toBe("TQ==");
    expect(encodeBase64(Uint8Array.from([77, 97]))).toBe("TWE=");
    expect(encodeBase64(Uint8Array.from([77, 97, 110]))).toBe("TWFu");
  });

  test("bytes above 127 are bytes, not code points", () => {
    /*
      The failure mode of `btoa(String.fromCharCode(...bytes))`: anything over
      127 becomes a multi-byte code point and the audio is corrupted from the
      first loud sample onwards. Compared against a known-good encoder.
    */
    const bytes = ramp(256);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  test("a slice-sized buffer encodes without spreading anything", () => {
    // 20 seconds of 16 kHz mono is 640 KB; `String.fromCharCode(...)` on that
    // many arguments is a stack overflow rather than a slow path.
    const bytes = ramp(640 * 1024);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
