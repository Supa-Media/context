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
  /**
   * The editor's own draft this one started from (`legacyDraftFor`), as it was
   * typed before the note was shared: what clears that draft and its queued
   * write once this lands, whatever was typed on top of it since.
   */
  adopt?: { text: string; baseEtag: string };
}

/**
 * Typing the editor already held when the note turned shared under it — the
 * read after a rename, or after a new note's first save, is the first to come
 * back with a `c2.` version — taken up as a draft at once, so the note goes on
 * taking typing while that typing is sent. It used to wait for a read and then
 * a replacement with the note read-only, about five seconds after every
 * rename typed straight through (Dev2, 2026-10-27). `undefined` without a
 * shared version to send it against: that one still waits for the read.
 */
export function draftFromLegacy(legacy: { baseline: string; desired: string; baseEtag?: string | null } | undefined): Recovery | undefined {
  const baseEtag = legacy?.baseEtag;
  if (legacy === undefined || typeof baseEtag !== "string" || documentIdOf(baseEtag) === null) return undefined;
  return { baseline: legacy.baseline, desired: legacy.desired, baseEtag, offline: true, adopt: { text: legacy.desired, baseEtag } };
}

/**
 * The record this device kept for the note, read when the controller starts,
 * with a draft the controller was already holding (`draftFromLegacy`, and any
 * typing since) laid over it — only over a record that holds nothing of the
 * note yet, as the editor's draft was only ever carried onto a cold start. A
 * record with a document, unsent updates or a draft of its own is kept as it
 * is: carrying whole text over unsent updates of the same words would send
 * them twice.
 */
export function keptOver<R extends { documentId: string | null; snapshot: string; pending: unknown[]; recovery?: Recovery }>(stored: R, held: R): R {
  if (held.recovery === undefined || stored.recovery !== undefined || stored.pending.length > 0 || holdsDocument(stored.snapshot)) return stored;
  if (stored.documentId !== null && stored.documentId !== held.documentId) return stored;
  return { ...stored, documentId: held.documentId, recovery: held.recovery };
}

/**
 * Whether carrying `draft` onto `note` loses none of the note's words. Only its
 * opening heading may be replaced, since that is the title a person retitles.
 */
export function keepsEveryWord(draft: string, note: string): boolean {
  const body = note.replace(/^\s*#[^\n]*(\n|$)/, "").trim();
  return body === "" || draft.includes(body);
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
