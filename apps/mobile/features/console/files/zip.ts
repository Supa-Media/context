/**
 * A folder, as one file somebody can keep.
 *
 * ## Why this is written out rather than installed
 *
 * Non-negotiable #1 is that the customer can always leave with their content,
 * and that the exit is "never gated, never degraded, and never behind a
 * paywall". Until now the console had no download at all: the only way to get a
 * note out of Context was to open the bucket somewhere else, which is a true
 * exit and a poor one — it asks somebody to hold cloud credentials to read
 * their own writing.
 *
 * A zip writer is the whole of what a folder download needs and it is about
 * eighty lines, so it is written here rather than pulled in. Three reasons, in
 * the order they mattered:
 *
 *  - **The one in the tree is not ours.** `fflate` is present as a transitive
 *    dependency of something else. Importing it would make a build of this app
 *    depend on a version nothing in this repository declares, and the day that
 *    dependency drops it the download stops working with no line in any
 *    manifest to explain why.
 *  - **This is on the exit path.** A promise that must work after somebody has
 *    cancelled is a promise to keep the machinery small enough to be sure of.
 *  - **Nothing here needs compression.** Markdown zips well and these archives
 *    are small; `store` costs bytes on the wire and buys a format with no
 *    inflate to get wrong. It is the same trade `.excalidraw.md` already makes.
 *
 * ## What it produces
 *
 * A ZIP with one `store`d entry per file, local headers, a central directory
 * and an end-of-central-directory record: the 1989 format, which every
 * operating system's built-in extractor opens without a dialog. Deliberately
 * **not** Zip64 — a context that exceeds four gigabytes in one download is a
 * different feature (a resumable export), not a bigger header, and `buildZip`
 * refuses rather than writing an archive that silently truncates.
 *
 * Names are stored as UTF-8 with the language-encoding flag set, so a note
 * called `café 🌍.md` comes out of the archive under its own name rather than
 * as mojibake. Paths are relative and carry no leading slash and no `..`,
 * because an archive is untrusted input to whatever opens it and this one is
 * ours to get right.
 */

/** One file in the archive. `path` is relative, `/`-separated. */
export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  /** Last-modified, for the entry's DOS timestamp. Defaults to now. */
  modified?: Date;
}

/**
 * Four gigabytes minus one: the largest size the 1989 header can express.
 *
 * Refused rather than truncated. An archive whose central directory claims a
 * smaller file than it holds extracts to a corrupt note, and the person
 * finding out is someone who has already left.
 */
const ZIP32_LIMIT = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS date and time, which is what a 1989 header carries.
 *
 * Two-second resolution and an epoch of 1980, both of which are the format's
 * rather than a choice. A date before 1980 cannot be expressed, so it is
 * clamped to the epoch instead of wrapping into a timestamp in the future.
 */
function dosStamp(when: Date): { date: number; time: number } {
  const year = when.getFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  };
}

/**
 * A path an extractor can be handed safely.
 *
 * Leading slashes and `..` segments out, backslashes normalised, and the
 * result refused if nothing is left. An archive is untrusted input wherever it
 * lands, and "it was our own console that wrote it" is exactly the reasoning
 * every zip-slip advisory begins by quoting.
 */
export function zipPath(path: string): string {
  const parts = String(path)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..");
  return parts.join("/");
}

function writeUint32(into: Uint8Array, at: number, value: number): void {
  into[at] = value & 0xff;
  into[at + 1] = (value >>> 8) & 0xff;
  into[at + 2] = (value >>> 16) & 0xff;
  into[at + 3] = (value >>> 24) & 0xff;
}

function writeUint16(into: Uint8Array, at: number, value: number): void {
  into[at] = value & 0xff;
  into[at + 1] = (value >>> 8) & 0xff;
}

export class ZipTooLarge extends Error {}

/** The archive, as bytes. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const name = zipPath(entry.path);
    if (name === "") throw new ZipTooLarge(`an entry with no usable name: ${entry.path}`);
    const nameBytes = encoder.encode(name);
    if (entry.bytes.length > ZIP32_LIMIT) {
      throw new ZipTooLarge(`${name} is too large for a zip archive`);
    }
    return {
      nameBytes,
      bytes: entry.bytes,
      crc: crc32(entry.bytes),
      stamp: dosStamp(entry.modified ?? new Date()),
    };
  });

  const localSize = prepared.reduce(
    (total, one) => total + 30 + one.nameBytes.length + one.bytes.length,
    0,
  );
  const centralSize = prepared.reduce((total, one) => total + 46 + one.nameBytes.length, 0);
  if (localSize + centralSize + 22 > ZIP32_LIMIT) {
    throw new ZipTooLarge("this folder is too large to download as one archive");
  }

  const out = new Uint8Array(localSize + centralSize + 22);
  const offsets: number[] = [];
  let at = 0;

  for (const one of prepared) {
    offsets.push(at);
    writeUint32(out, at, 0x04034b50);
    writeUint16(out, at + 4, 20); // version needed: 2.0, which is `store` plus folders
    // Bit 11: the name is UTF-8. Without it an extractor reads the bytes as
    // the local code page and a note with an accent in its name comes out
    // mangled — on the one archive somebody keeps after they leave.
    writeUint16(out, at + 6, 0x0800);
    writeUint16(out, at + 8, 0); // method: store
    writeUint16(out, at + 10, one.stamp.time);
    writeUint16(out, at + 12, one.stamp.date);
    writeUint32(out, at + 14, one.crc);
    writeUint32(out, at + 18, one.bytes.length);
    writeUint32(out, at + 22, one.bytes.length);
    writeUint16(out, at + 26, one.nameBytes.length);
    writeUint16(out, at + 28, 0); // no extra field
    out.set(one.nameBytes, at + 30);
    out.set(one.bytes, at + 30 + one.nameBytes.length);
    at += 30 + one.nameBytes.length + one.bytes.length;
  }

  const centralAt = at;
  for (let index = 0; index < prepared.length; index += 1) {
    const one = prepared[index];
    writeUint32(out, at, 0x02014b50);
    writeUint16(out, at + 4, 20); // version made by
    writeUint16(out, at + 6, 20); // version needed
    writeUint16(out, at + 8, 0x0800);
    writeUint16(out, at + 10, 0); // method: store
    writeUint16(out, at + 12, one.stamp.time);
    writeUint16(out, at + 14, one.stamp.date);
    writeUint32(out, at + 16, one.crc);
    writeUint32(out, at + 20, one.bytes.length);
    writeUint32(out, at + 24, one.bytes.length);
    writeUint16(out, at + 28, one.nameBytes.length);
    writeUint16(out, at + 30, 0); // extra field
    writeUint16(out, at + 32, 0); // comment
    writeUint16(out, at + 34, 0); // disk number
    writeUint16(out, at + 36, 0); // internal attributes
    writeUint32(out, at + 38, 0); // external attributes
    writeUint32(out, at + 42, offsets[index]);
    out.set(one.nameBytes, at + 46);
    at += 46 + one.nameBytes.length;
  }

  writeUint32(out, at, 0x06054b50);
  writeUint16(out, at + 4, 0); // this disk
  writeUint16(out, at + 6, 0); // disk with the central directory
  writeUint16(out, at + 8, prepared.length);
  writeUint16(out, at + 10, prepared.length);
  writeUint32(out, at + 12, centralSize);
  writeUint32(out, at + 16, centralAt);
  writeUint16(out, at + 20, 0); // no archive comment

  return out;
}

/**
 * A file name an operating system will accept, from a context path.
 *
 * Every separator and every character Windows refuses becomes `-`, because an
 * archive that will not save is not an exit. The extension is the caller's:
 * this is about the stem.
 */
export function downloadName(path: string, extension: string): string {
  const leaf = zipPath(path).split("/").pop() ?? "";
  /*
    Control characters are in the set deliberately, which is why the rule is
    disabled rather than the class narrowed: a name carrying a newline or a NUL
    is refused by every filesystem there is, and a download that will not save
    is not an exit.
  */
  // eslint-disable-next-line no-control-regex
  const unusable = /[\\/:*?"<>|\u0000-\u001f]/g;
  const stem = leaf.replace(/\.md$/i, "").replace(unusable, "-").trim();
  return `${stem === "" ? "context" : stem}${extension}`;
}
