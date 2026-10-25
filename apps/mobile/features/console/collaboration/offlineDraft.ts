import * as Y from "yjs";
import { fromBase64 } from "../presence/sharedDoc";

/**
 * Typing into a shared note before this device holds its shared document.
 *
 * A note opens in durable mode when its version is a `c2.` one, and durable
 * mode used to keep the editor read-only until the gateway's first read gave
 * it the note's Yjs document: the native replica must not invent character
 * identities of its own. On a phone with no connection that read never comes,
 * and on a weak one it can take the whole 30-second request timeout, so a note
 * never opened on that phone showed its words and no cursor (Dev2,
 * 2026-10-25: "I just can't edit my notes offline").
 *
 * The draft is the way through that keeps the rule. Typing is kept as whole
 * text, never as Yjs updates, against the version the editor was showing
 * (`baseEtag`, a `c2.<documentId>.<revision>` token), on the device, in the
 * controller's record. When the gateway can be reached it goes as the
 * exact-base replacement an older offline draft already takes: the server
 * diffs that version's text to the draft and applies the result to the
 * document as it is now (`replaceText` in `@context/collaboration`), so
 * somebody else's edits made meanwhile are merged, not overwritten. Only
 * after that answer does the editor bind to the shared document.
 */

/** How long the first read may take before the note takes typing anyway. */
export const DRAFT_WAIT_MS = 1_200;

/** A draft kept on the device, in the record's `recovery` slot. */
export interface Recovery {
  baseline: string;
  desired: string;
  baseEtag?: string | null;
  /** Typed here before the shared document arrived; see this file. Absent on an older legacy draft. */
  offline?: true;
}

const C2 = /^c2\.([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)$/;

/** The shared document a `c2.` version belongs to, or `null` for any other version. */
export function documentIdOf(etag: string | null | undefined): string | null {
  if (typeof etag !== "string") return null;
  return C2.exec(etag)?.[1] ?? null;
}

/**
 * Whether a kept snapshot holds anything of the document. An empty `Y.Doc`
 * still encodes to a non-empty string, and a record that kept one opened the
 * note ready and blank: its words gone until a read put them back, which on a
 * weak connection might not come.
 */
export function holdsDocument(snapshot: string): boolean {
  if (snapshot === "") return false;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, fromBase64(snapshot));
    return Y.encodeStateVector(doc).length > 1;
  } catch {
    return false;
  } finally {
    doc.destroy();
  }
}
