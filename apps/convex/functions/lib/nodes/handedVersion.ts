/**
 * The version a keyed note is handed, and the version a row move is asked about.
 *
 * A read of a note (`fileOps/reading.ts`) hands out the collaboration etag
 * (`c2.<document>.<revision>`) of an editable note, and the Markdown etag of
 * anything else. The row carries the Markdown etag alone, so a move or trash
 * compares its caller's version with the row's. Without this module the two
 * families never agree, and a note nobody changed refuses its own rename.
 *
 * So a row move takes the caller's collaboration etag as the Markdown etag it
 * stands for, when that is still the note's current version; a stale one is
 * passed on unchanged and refused as a change. And a move hands back the etag a
 * read of its new name gives, so the two are the same token.
 */

import { readDocument as readCollaborationDocument, eligible as collaborationEligible, supported as collaborationSupported } from "@context/collaboration";
import { isEncryptedNote } from "../noteEncryption";
import type { FileStore } from "../fileOps/store";

/** The collaboration etag a read hands out: `c2.<documentId>.<revision>`. */
const COLLABORATION_ETAG = /^c2\./;

export interface HandedVersion {
  /** What a read of the note hands out. */
  etag: string;
  /** The Markdown object's etag, which the row carries. */
  rawEtag: string;
}

/** The version a read of `path` hands out, or `null` when there is no note there. Starts the note's document as a read does. */
export async function handedVersion(store: FileStore, path: string): Promise<HandedVersion | null> {
  const object = await store.get(path);
  if (object === null) return null;
  const text = await object.text();
  if (isEncryptedNote(text) || !collaborationSupported(store) || !collaborationEligible(path, text)) {
    return { etag: object.etag, rawEtag: object.etag };
  }
  const document = await readCollaborationDocument(store, path);
  return { etag: document.etag, rawEtag: document.rawEtag };
}

/**
 * The Markdown etag a caller's version stands for, for a row move to compare.
 * Anything that is not a collaboration etag is returned as it is.
 */
export async function rowEtagFor(store: FileStore, path: string, expectedEtag: string | undefined): Promise<string | undefined> {
  if (expectedEtag === undefined || !COLLABORATION_ETAG.test(expectedEtag)) return expectedEtag;
  const current = await handedVersion(store, path).catch(() => null);
  return current !== null && current.etag === expectedEtag ? current.rawEtag : expectedEtag;
}

/** The etag a read of `path` hands out after a move, or `undefined` when it cannot be read. */
export async function handedEtagAt(store: FileStore, path: string): Promise<string | undefined> {
  return (await handedVersion(store, path).catch(() => null))?.etag;
}
