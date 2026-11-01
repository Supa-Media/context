/**
 * Measuring a workspace's editing-history revisions: how much of `revisions/`
 * is a document's current revision (named by `documents/<id>.json` as its
 * `revision` or `pending.revision`, read on every note load) and how much is
 * older. Read only, and counts only: never a key, an id or a body.
 * Layout: `packages/collaboration/src/storage.js`.
 */

import type { BodyStore } from "./bodies";
import { historyPart } from "./bodies";

const ROOT = ".context/collaboration/v1/";
const DOCUMENT_PREFIX = `${ROOT}documents/`;
const REVISION_PREFIX = `${ROOT}revisions/`;

export interface Tally {
  keys: number;
  bytes: number;
  largest: number;
}

export interface RevisionCounts {
  documents: number;
  unreadable: number;
  current: Tally;
  older: Tally;
}

export const emptyRevisionCounts = (): RevisionCounts => ({
  documents: 0,
  unreadable: 0,
  current: { keys: 0, bytes: 0, largest: 0 },
  older: { keys: 0, bytes: 0, largest: 0 },
});

function add(tally: Tally, size: number): void {
  tally.keys += 1;
  tally.bytes += size;
  if (size > tally.largest) tally.largest = size;
}

/** The revision names a document's state points at: its accepted one and any pending one. */
function currentNames(state: unknown): Set<string> {
  const names = new Set<string>();
  if (state && typeof state === "object") {
    const record = state as { revision?: unknown; pending?: { revision?: unknown } | null };
    if (typeof record.revision === "string") names.add(record.revision);
    if (record.pending && typeof record.pending.revision === "string") names.add(record.pending.revision);
  }
  return names;
}

async function measureDocument(bucket: BodyStore, key: string, into: RevisionCounts): Promise<void> {
  const documentId = key.slice(DOCUMENT_PREFIX.length, -".json".length);
  const object = await bucket.get(key);
  if (object === null) return;
  into.documents += 1;
  let names: Set<string>;
  try {
    names = currentNames(JSON.parse(new TextDecoder().decode(await object.arrayBuffer())));
  } catch {
    into.unreadable += 1;
    return;
  }
  const prefix = `${REVISION_PREFIX}${documentId}/`;
  let cursor: string | undefined;
  for (let pages = 0; pages < 10_000; pages += 1) {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const entry of page.objects ?? []) {
      const name = entry.key.slice(prefix.length);
      if (name.includes("/") || !name.endsWith(".json")) continue;
      const size = typeof entry.size === "number" ? entry.size : 0;
      add(names.has(name.slice(0, -".json".length)) ? into.current : into.older, size);
    }
    if (page.truncated !== true || typeof page.cursor !== "string") break;
    cursor = page.cursor;
  }
}

/**
 * One page: up to `limit` keys under `documents/` from `cursor`, each current
 * document read and its revisions listed and split. Answers the counts and
 * the next cursor, `null` when every document has been measured.
 */
export async function revisionsPage(
  bucket: BodyStore,
  { cursor, limit, width = 8 }: { cursor?: string; limit: number; width?: number },
): Promise<{ counts: RevisionCounts; next: string | null }> {
  const counts = emptyRevisionCounts();
  const page = await bucket.list({ prefix: DOCUMENT_PREFIX, ...(cursor ? { cursor } : {}), limit });
  const keys = (page.objects ?? []).map((entry) => entry.key).filter((key) => historyPart(key) === "documents");
  for (let start = 0; start < keys.length; start += width) {
    await Promise.all(keys.slice(start, start + width).map((key) => measureDocument(bucket, key, counts)));
  }
  return { counts, next: page.truncated === true && typeof page.cursor === "string" ? page.cursor : null };
}

/** `more` added into `into`. */
export function addRevisionCounts(into: RevisionCounts, more: RevisionCounts): RevisionCounts {
  into.documents += more.documents;
  into.unreadable += more.unreadable;
  for (const side of ["current", "older"] as const) {
    into[side].keys += more[side].keys;
    into[side].bytes += more[side].bytes;
    into[side].largest = Math.max(into[side].largest, more[side].largest);
  }
  return into;
}
