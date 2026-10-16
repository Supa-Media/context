/**
 * A note's stable id and the bucket key its bytes live at once it is keyed
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`). The control
 * plane mints ids for rows it inserts; the store seam (`idLayout.js`) mints one
 * for a note it creates, before a byte is written, so the note lands at its id
 * key and never at its path. One implementation for both, so the two can never
 * disagree on what a key is.
 *
 * Built only from Web Crypto, which the Workers runtime, the Convex runtime and
 * Node all have.
 */

/**
 * A UUIDv7: 48 bits of milliseconds, then random bits, so ids sort roughly by
 * creation and never repeat in practice.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function newNoteId(now = Date.now()) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let millis = Math.floor(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = millis % 256;
    millis = Math.floor(millis / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `value` is a note id: a lowercase UUIDv7. */
export function isNoteId(value) {
  return typeof value === "string" && NOTE_ID.test(value);
}

/**
 * The key a note's bytes live at. `.md` is a note; anything else keeps its
 * lowercased extension (a name's last dot after its first character, as
 * `path.extname` reads it), and a name with none keeps none.
 *
 * @param {string} noteId
 * @param {string} path
 * @returns {string}
 */
export function idKeyFor(noteId, path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return extension === ".md" ? `notes/${noteId}.md` : `files/${noteId}${extension}`;
}
