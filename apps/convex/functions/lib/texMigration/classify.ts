/**
 * Which of a personal workspace's Tex rows still keep their note in the bucket,
 * and which already keep it in the person's Durable Object (decided by the
 * owner, 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A row keyed at its bucket id key (`idKeyFor`) is `move`: its body is still
 * the bucket's to give up. A row keyed at the Tex form of that same id key for
 * the workspace's own owner is `moved`. Anything else (a path key, another
 * owner's Tex form, a note without an id) is `other`, and is never touched.
 */

import { texKeyFor } from "../../../../mcp/src/store/texRouting.js";
import { idKeyFor, isNoteId } from "../nodes/noteIds";

export type TexRowState = "move" | "moved" | "other";

export interface TexRowKey {
  path: string;
  noteId?: string;
  storageKey: string;
}

export function texRowState(row: TexRowKey, owner: string): TexRowState {
  if (row.noteId === undefined || !isNoteId(row.noteId)) return "other";
  const idKey = idKeyFor(row.noteId, row.path);
  if (row.storageKey === idKey) return "move";
  if (row.storageKey === texKeyFor(owner, idKey)) return "moved";
  return "other";
}

/** Whether two bodies are the same bytes, compared whole. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** An etag without its quotes: the bucket adapters' comparison, so `"abc"` and `abc` are one version. */
export function bareEtag(tag: string | undefined | null): string {
  return typeof tag === "string" ? tag.replace(/"/g, "") : "";
}
