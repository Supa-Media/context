/**
 * A sound somebody uploaded for a cast scene (Dev2, 2026-09-29: "Built-in +
 * uploads"). It is stored the way a pasted image is: in the workspace's own
 * bucket, in the opaque asset store under a name made from its bytes, and it
 * is read back only for a note that names it, so it follows that note's
 * privacy and leaves with the bucket.
 *
 * **The bytes decide what a file is, never its name or the type a browser
 * declared.** A sound is kept only when its first bytes are an MP3, WAV, Ogg or
 * M4A file, and it is stored under the type those bytes say.
 */

export type SoundExtension = "mp3" | "wav" | "ogg" | "m4a";

export const SOUND_CONTENT_TYPES: Readonly<Record<SoundExtension, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

export const SOUND_EXTENSIONS: readonly SoundExtension[] = ["mp3", "wav", "ogg", "m4a"];

/**
 * The most one uploaded sound may be. A scene's sound is a second or two;
 * this leaves room for a long one in a lossless format and no more.
 */
export const MAX_SCENE_SOUND_BYTES = 2_000_000;

/** A stored scene sound's name: `sound-` and sixteen hex characters of its hash. */
export const SCENE_SOUND_LEAF = /^sound-[0-9a-f]{16}\.(mp3|wav|ogg|m4a)$/;

/** Whether a declared type is asking to store a sound (the bytes then decide which). */
export function isSoundUpload(contentType: string): boolean {
  return /^audio\//i.test(contentType.trim());
}

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length && [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

const M4A_BRANDS = ["M4A ", "M4B ", "mp42", "mp41", "isom", "iso2"];

/** What a file's first bytes say it is, of the four sound formats kept; `null` for anything else. */
export function sniffSoundType(input: ArrayBuffer | Uint8Array): SoundExtension | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "wav";
  if (ascii(bytes, 0, "OggS")) return "ogg";
  if (ascii(bytes, 4, "ftyp") && M4A_BRANDS.some((brand) => ascii(bytes, 8, brand))) return "m4a";
  if (ascii(bytes, 0, "ID3")) return "mp3";
  // An MPEG audio frame: eleven sync bits, then a layer that is not "reserved".
  // AAC's own frames (ADTS) set that layer to zero, so they are not taken for MP3.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0) return "mp3";
  return null;
}

export function sceneSoundLeaf(hash: string, extension: SoundExtension): string {
  const hex = hash.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 16);
  if (hex.length !== 16) throw new Error("A stored sound needs sixteen characters of its hash for its name.");
  return `sound-${hex}.${extension}`;
}
