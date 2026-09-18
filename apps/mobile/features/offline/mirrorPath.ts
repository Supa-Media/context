/**
 * A bucket path, turned into one filename that cannot be anything else.
 *
 * ## Why a note path is never joined onto the filesystem
 *
 * A bucket key is written by whoever can write to the bucket — Obsidian, an AI
 * client, a teammate, somebody in the storage provider's own console — and
 * `../../Library/Preferences/x.md` is a perfectly legal S3 key. The gateway
 * refuses control characters in the keys *it* writes, but the mirror downloads
 * whatever the bucket holds, so the bucket's contents are untrusted input to
 * the phone's filesystem. Joined onto the app's document directory, a key like
 * that is a write outside the mirror, into whatever the app keeps beside it —
 * the auth store included.
 *
 * So every segment the native store builds a path from goes through here, and
 * the output alphabet has **no separator and no dot**: lowercase letters,
 * digits, `-`, and `%XX` escapes for every other UTF-8 byte. `..` becomes
 * `%2E%2E`, `/` becomes `%2F`, and there is nothing left for a filesystem to
 * interpret. `__tests__/offlineMirrorStore.test.ts` writes traversal keys
 * through the real store over a fake disk that resolves `..` the way a real one
 * does, so a raw join escapes and the test sees it.
 *
 * ## Why uppercase letters are escaped too
 *
 * `Plan.md` and `plan.md` are two different notes in a bucket, and on a
 * case-insensitive filesystem they would be one file — each download
 * overwriting the other. iOS's APFS is case-sensitive today and macOS's
 * default is not, and this is not a fact worth betting a note body on, so the
 * name is made from an alphabet where case never carries meaning: `P` is
 * `%50`, and escapes are always written with uppercase hex so `%50` is never
 * also produced as `%5a`-style lowercase.
 *
 * ## Why a long path is hashed
 *
 * Both platforms cap a filename at 255 bytes, and escaping multiplies a
 * path's length by up to three. A name that would exceed `MAX_NAME` becomes
 * `~` + two independent 53-bit hashes + a readable prefix. `~` is outside the
 * short form's alphabet (it is escaped as `%7E` there), so a hashed name can
 * never equal an escaped one. A collision between two hashed names is not a
 * disclosure — both are notes in the same context at the same clearance — and
 * it is not even a wrong read: the body record carries its own path, and
 * `mirror.ts` treats a body whose path is not the one asked for as a miss.
 */

/** Well under 255 bytes, leaving room for anything a platform appends. */
const MAX_NAME = 200;

const KEEP = /[a-z0-9-]/;

function hex2(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, "0");
}

/** The UTF-8 bytes of a string, without depending on `TextEncoder`. */
export function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    let code = char.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      // A lone surrogate is encoded as the replacement character, as
      // `TextEncoder` would, rather than as bytes no decoder accepts.
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** A note's size as the bucket counts it. */
export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

function escape(text: string): string {
  let out = "";
  for (const char of text) {
    if (KEEP.test(char)) {
      out += char;
      continue;
    }
    for (const byte of utf8Bytes(char)) out += `%${hex2(byte)}`;
  }
  return out;
}

/** cyrb53: a small, well-distributed 53-bit string hash. Not cryptographic. */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * One path segment for a value this app did not choose — a workspace id, a
 * scope. Workspace ids are Convex ids and already safe; encoding them anyway
 * costs nothing and means no caller has to know that.
 */
export function segmentName(value: string): string {
  return value === "" ? "%00" : escape(value);
}

/** The filename a note's body is stored under. Never contains `/` or `.`. */
export function bodyFileName(path: string): string {
  const escaped = path === "" ? "%00" : escape(path);
  if (escaped.length <= MAX_NAME) return escaped;
  const digest =
    cyrb53(path, 0).toString(36).padStart(11, "0") + cyrb53(path, 1).toString(36).padStart(11, "0");
  return `~${digest}-${escaped.slice(0, MAX_NAME - digest.length - 2).replace(/%[0-9A-F]?$/, "")}`;
}

/** The inverse of `segmentName`, for reading a directory listing back. */
export function segmentValue(name: string): string | null {
  if (name === "%00") return "";
  if (!/^(?:[a-z0-9-]|%[0-9A-F]{2})+$/.test(name)) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    // Escapes that are not valid UTF-8 were not written by `segmentName`.
    return null;
  }
}
