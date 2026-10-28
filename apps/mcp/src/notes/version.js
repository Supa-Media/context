/**
 * A NOTE HAS ONE VERSION, AND EVERY TOOL NAMES IT THE SAME WAY.
 *
 * A note with editing history has two tags: its collaboration document's
 * (`c2.…`) and the stored Markdown object's. `read_note` handed out one while
 * `set_visibility`, the moves and `set_encryption` compared against the other,
 * so an agent that wrote a note and then changed its visibility with the etag
 * it was just given was told the note had changed, read it again and retried
 * (2026-10-28). The rule is now one function:
 *
 *  - a note whose document has started is at the document's version, and the
 *    Markdown etag it started from still names that version while nothing has
 *    changed since (`isCurrentEtag`, the rule `replaceText` enforces);
 *  - any other note is at its stored object's version.
 *
 * Checking starts no document: a read and a check agree without either one
 * paying the ~15 storage calls a document's first read costs.
 */

import { eligible, isCurrentEtag, readDocumentIfStarted, supported } from "@context/collaboration";
import { isEncryptedNote } from "../encryption.js";

/**
 * Whether `expected` is the version of a note whose stored object has
 * `rawEtag`, where `document` is its collaboration document or null.
 */
export function versionMatches(expected, { document, rawEtag }) {
  if (document) return isCurrentEtag(document, expected);
  return typeof expected === "string" && expected !== "" && expected === rawEtag;
}

/**
 * The note's current version: `{ etag, document }`, `document` being its
 * started collaboration document or null. `stored` is the object's text, read
 * by the caller. Throws when a started document cannot be read.
 */
export async function currentVersion(store, path, object, stored) {
  if (supported(store) && !isEncryptedNote(stored) && eligible(path, stored)) {
    const document = await readDocumentIfStarted(store, path);
    if (document) return { etag: document.etag, document };
  }
  return { etag: object.etag, document: null };
}
