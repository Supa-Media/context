/**
 * Reading a recording that is still being written, and cutting pieces off it.
 *
 * ## THE BUG THIS EXISTS FOR
 *
 * `audio.ts` rotated chunks by **stopping and restarting the recorder** every
 * twenty seconds: `stop()`, take the finished `.m4a`, `prepareToRecordAsync()`,
 * `record()`. That works for exactly as long as the app is in front.
 *
 * iOS refuses to *start* a recording from the background. The error has a name
 * — `AVAudioSessionErrorCodeCannotStartRecording` — and it is a privacy
 * restriction rather than a bug: an app that is already recording when it is
 * backgrounded may carry on, and an app that is not may not begin. Apple's own
 * forum thread on it is unambiguous, and the exemption is narrow: *"I am only
 * able to start recording in the background after an interruption (if I was
 * already recording before the interruption started). Otherwise, it's
 * blocked."*
 *
 * So the background-audio entitlement was never the problem, and neither were
 * JavaScript timers. Every twenty seconds this app voluntarily gave up the one
 * thing iOS lets a backgrounded recorder keep — a recording already in
 * progress — and then asked for it back. In front, granted. With the phone
 * locked, refused, and the meeting is over. The owner's report is exactly that
 * shape: a transcript that runs to 03:01 and stops, on a phone that locked.
 *
 * **The fix is to stop rotating the device.** One `record()` per meeting, and
 * the pieces are cut out of the file it is writing while it goes on writing —
 * which is what every meeting recorder that survives a lock does.
 *
 * ## Why this means linear PCM
 *
 * A growing `.m4a` cannot be read. AAC in an MPEG-4 container is not valid
 * until `stop()` writes the `moov` atom, so a prefix of one is not a shorter
 * recording, it is not a recording at all. Linear PCM in a WAVE container is
 * the opposite: the header is written up front and the samples are appended,
 * so the bytes on disk at any moment *are* the audio so far.
 *
 * That costs size — 16 kHz mono 16-bit is 32 KB a second, about 115 MB an hour
 * against roughly 8 MB for AAC — and buys the property the feature needs. The
 * file lives in the cache directory for the length of one meeting and is
 * deleted with it, and 16 kHz mono is what the transcription model wants
 * anyway, so nothing downstream is worse off.
 *
 * ## Nothing here trusts what was asked for
 *
 * `parseWavHeader` reads the format out of the file the recorder actually
 * produced rather than assuming the options were honoured. Two reasons, and
 * the second is the one that decided it:
 *
 *  - **The header is not always 44 bytes.** A canonical WAVE header is, but the
 *    format permits chunks before `data` — `LIST`, `fact`, padding — and
 *    CoreAudio writes what it likes. Slicing from a hard-coded 44 would put
 *    header bytes into the audio and shift every sample after it.
 *  - **A sample rate the device substituted would silently change the pitch.**
 *    `AVAudioRecorder` may not honour a requested rate; a slice labelled 16 kHz
 *    that is really 44.1 kHz transcribes as gibberish at a third speed, which
 *    is the kind of failure that looks like a bad model rather than a bad
 *    header.
 *
 * So the format travels with the slices, read once from the real file.
 *
 * Everything in this module is pure: bytes in, bytes out, no device and no
 * file system. `__tests__/meetingsWav.test.ts` drives it directly.
 */

/** What the recorder is actually producing, read out of its own header. */
export interface PcmFormat {
  /** Byte offset at which sample data begins. */
  dataOffset: number;
  sampleRate: number;
  channels: number;
  /** Bits per sample. 16 in every configuration this app asks for. */
  bitDepth: number;
}

/**
 * What this app asks the recorder for.
 *
 * 16 kHz mono is the transcription model's own input format, so asking for it
 * at the microphone means nothing has to resample later and the file on disk is
 * as small as linear PCM gets. It is a request: `parseWavHeader` reads what
 * actually came back, and the slices carry that.
 */
export const PCM_SAMPLE_RATE = 16_000;
export const PCM_CHANNELS = 1;
export const PCM_BIT_DEPTH = 16;

/** The media type a slice is sent as. Already on the gateway's allowlist. */
export const WAV_MIME = "audio/wav";

/** A canonical WAVE header, and the most this module ever reads to find one. */
export const WAV_HEADER_BYTES = 44;

/**
 * How far into the file to look for the `data` chunk before giving up.
 *
 * Generous enough for the chunks CoreAudio might write ahead of the samples,
 * and bounded so a file that is not a WAVE at all — a truncated write, a
 * recorder that ignored the format entirely — is refused rather than scanned
 * to the end of a hundred megabytes of audio looking for four bytes that would
 * occur in it by chance anyway.
 */
export const WAV_HEADER_SCAN_BYTES = 4096;

const RIFF = 0x52494646;
const WAVE = 0x57415645;
const FMT = 0x666d7420;
const DATA = 0x64617461;

function u32be(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)
  ) >>> 0;
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)
  ) >>> 0;
}

function u16le(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)) >>> 0;
}

/**
 * Where the samples start and what they are, or `null`.
 *
 * Walks the RIFF chunk list rather than assuming a layout: every chunk is a
 * four-character id, a little-endian length, that many bytes, and a pad byte
 * when the length is odd. `fmt ` says what the samples are and `data` says
 * where they begin.
 *
 * **The `data` chunk's own length is read and thrown away**, and that is the
 * point rather than an oversight. In a file that is still being written it is
 * whatever was true when the header was flushed — often zero, sometimes a
 * placeholder like `0xFFFFFFFF` — and believing it would cap every slice at the
 * length of the first moment of the meeting. The file's *actual* size is the
 * only honest answer to "how much audio is there", and the caller has it.
 *
 * `null` for anything that is not linear PCM this module can cut: a compressed
 * payload in a WAVE wrapper, a bit depth that is not a whole number of bytes,
 * a header that is not there yet because the recorder has not flushed. The
 * caller retries on the next tick rather than sending something it cannot
 * describe.
 */
export function parseWavHeader(bytes: Uint8Array): PcmFormat | null {
  if (bytes.length < 12) return null;
  if (u32be(bytes, 0) !== RIFF) return null;
  if (u32be(bytes, 8) !== WAVE) return null;

  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let audioFormat = 0;

  let at = 12;
  const limit = Math.min(bytes.length, WAV_HEADER_SCAN_BYTES);
  while (at + 8 <= limit) {
    const id = u32be(bytes, at);
    const size = u32le(bytes, at + 4);
    const body = at + 8;

    if (id === FMT) {
      if (body + 16 > bytes.length) return null;
      audioFormat = u16le(bytes, body);
      channels = u16le(bytes, body + 2);
      sampleRate = u32le(bytes, body + 4);
      bitDepth = u16le(bytes, body + 14);
    }

    if (id === DATA) {
      /*
        Format 1 is PCM and 0xFFFE is `WAVE_FORMAT_EXTENSIBLE`, which CoreAudio
        writes for some configurations and which is still linear PCM — its
        extension names a sub-format this module does not need, because the
        fields it would read are the ones already read above. Anything else in
        a WAVE wrapper is compressed, and a compressed prefix is as unreadable
        as the `.m4a` this whole module exists to stop using.
      */
      if (audioFormat !== 1 && audioFormat !== 0xfffe) return null;
      if (channels <= 0 || sampleRate <= 0) return null;
      if (bitDepth <= 0 || bitDepth % 8 !== 0) return null;
      return { dataOffset: body, sampleRate, channels, bitDepth };
    }

    // Chunks are word-aligned: an odd length is followed by one pad byte.
    const advance = 8 + size + (size % 2);
    // A zero-length chunk would otherwise spin here forever, and a length that
    // overflows the scan is a header this module cannot read.
    if (advance <= 8 && id !== DATA) return null;
    at += advance;
  }
  return null;
}

/** Bytes per sample frame — one sample on every channel. */
export function frameBytes(format: PcmFormat): number {
  return (format.bitDepth / 8) * format.channels;
}

/**
 * Round a byte count down to a whole number of sample frames.
 *
 * The recorder is writing while this module reads, so the last bytes of a slice
 * are as likely as not to be half of a sample. Sending a half sample shifts
 * every sample after it by one byte — for 16-bit stereo that is a channel swap
 * and for mono it is white noise — and, worse, it shifts the *next* slice too,
 * because the offset the caller advances by is this one's length. Cutting on a
 * frame boundary is what makes a stream of slices reassemble into the recording.
 */
export function alignToFrame(byteLength: number, format: PcmFormat): number {
  const frame = frameBytes(format);
  if (frame <= 0) return 0;
  return Math.max(0, Math.floor(byteLength / frame) * frame);
}

/** How long a run of samples lasts, in milliseconds. */
export function pcmDurationMs(byteLength: number, format: PcmFormat): number {
  const perSecond = frameBytes(format) * format.sampleRate;
  if (perSecond <= 0) return 0;
  return Math.round((byteLength / perSecond) * 1000);
}

/** How many bytes hold this many milliseconds, on a frame boundary. */
export function pcmBytesForMs(ms: number, format: PcmFormat): number {
  const perSecond = frameBytes(format) * format.sampleRate;
  return alignToFrame(Math.max(0, Math.round((ms / 1000) * perSecond)), format);
}

function writeAscii(into: Uint8Array, at: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    into[at + index] = text.charCodeAt(index);
  }
}

function writeU32le(into: Uint8Array, at: number, value: number): void {
  into[at] = value & 0xff;
  into[at + 1] = (value >>> 8) & 0xff;
  into[at + 2] = (value >>> 16) & 0xff;
  into[at + 3] = (value >>> 24) & 0xff;
}

function writeU16le(into: Uint8Array, at: number, value: number): void {
  into[at] = value & 0xff;
  into[at + 1] = (value >>> 8) & 0xff;
}

/**
 * A complete, self-contained WAVE file around a run of samples.
 *
 * "Self-contained" is the contract the transcription route states in its own
 * words — *"ONE rotated chunk: a complete, self-contained audio file"* — and it
 * is what lets a slice out of the middle of a meeting be decoded by something
 * that has never seen the rest of it. The header is the canonical 44 bytes with
 * the format copied from the recording the samples came out of.
 */
export function wavFile(pcm: Uint8Array, format: PcmFormat): Uint8Array {
  const blockAlign = frameBytes(format);
  const byteRate = blockAlign * format.sampleRate;
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length);

  writeAscii(out, 0, "RIFF");
  writeU32le(out, 4, 36 + pcm.length);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  writeU32le(out, 16, 16);
  writeU16le(out, 20, 1);
  writeU16le(out, 22, format.channels);
  writeU32le(out, 24, format.sampleRate);
  writeU32le(out, 28, byteRate);
  writeU16le(out, 32, blockAlign);
  writeU16le(out, 34, format.bitDepth);
  writeAscii(out, 36, "data");
  writeU32le(out, 40, pcm.length);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64, written out rather than borrowed.
 *
 * `Buffer` is Node's and is not in this runtime; `btoa` is a browser API that
 * Hermes does not ship and that takes a string of code points rather than
 * bytes, so the usual `btoa(String.fromCharCode(...bytes))` is both unavailable
 * and — for a slice of audio, spread over hundreds of thousands of arguments —
 * a stack overflow waiting to happen. Nineteen lines of table lookup has no
 * dependency and no size limit.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const word = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out +=
      BASE64[(word >>> 18) & 63] +
      BASE64[(word >>> 12) & 63] +
      BASE64[(word >>> 6) & 63] +
      BASE64[word & 63];
  }
  const left = bytes.length - index;
  if (left === 1) {
    const word = (bytes[index] ?? 0) << 16;
    out += BASE64[(word >>> 18) & 63] + BASE64[(word >>> 12) & 63] + "==";
  } else if (left === 2) {
    const word = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    out +=
      BASE64[(word >>> 18) & 63] +
      BASE64[(word >>> 12) & 63] +
      BASE64[(word >>> 6) & 63] +
      "=";
  }
  return out;
}
