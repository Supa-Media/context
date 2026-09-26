import { noteHeading, noteProperties } from "../../../mcp/src/lists.js";
import { noteLede } from "../console/files/folderPage/lede";
import { currentEpoch } from "./epoch";
import type { CacheScope } from "./keys";
import { isNotePath, mirroredBodyAt, parseIndex } from "./mirror";
import type { MirrorStore } from "./mirrorStoreCore";
import type { ListNote, ListSource, PropertyValue } from "../console/files/listBlock/model";

/**
 * The notes a folder list chooses from, read off this device's copy.
 *
 * A folder list (`docs/decisions/folder-lists.md`) filters notes by their
 * frontmatter, and the console has no server-side table of frontmatter: the
 * mirror is the one place every note the person can see is already held. So
 * this reads the mirror's index at exactly one clearance — the rule
 * `mirrorSearch.ts` states, so a `team` session never reads a body filed at
 * `private` — and parses the frontmatter of the notes under one folder.
 *
 * Only properties, the first heading and the first paragraph are kept, in
 * memory, keyed by etag so a note is re-read only when it changes. Encrypted notes are left out: their frontmatter is inside
 * the envelope. `forgetMirrorLists` drops it all beside every mirror clear.
 */

interface Held {
  store: MirrorStore;
  epoch: number;
  notes: Map<string, { etag: string; note: ListNote }>;
}

const held = new Map<string, Held>();
let generation = 0;

function keyOf(scope: CacheScope, workspaceId: string): string {
  return `${scope}\u001f${workspaceId}`;
}

export function forgetMirrorLists(workspaceId?: string): void {
  generation += 1;
  for (const key of [...held.keys()]) {
    if (workspaceId === undefined || key.endsWith(`\u001f${workspaceId}`)) held.delete(key);
  }
}

function inFolder(path: string, folder: string, subfolders: boolean): boolean {
  const prefix = folder === "" ? "" : `${folder}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.split("/").some((segment) => segment.startsWith("."))) return false;
  return subfolders || !rest.includes("/");
}

const READ_BATCH = 32;

export async function mirroredListNotes(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
  folder: string,
  subfolders: boolean,
): Promise<ListSource | null> {
  const epoch = currentEpoch();
  const startedAt = generation;
  const ended = (): boolean => currentEpoch() !== epoch || generation !== startedAt;
  const key = keyOf(scope, workspaceId);
  let memo = held.get(key);
  if (memo === undefined || memo.epoch !== epoch || memo.store !== store) {
    memo = { store, epoch, notes: new Map() };
    held.set(key, memo);
  }

  const index = parseIndex(await store.readIndex(scope, workspaceId));
  if (ended() || index === null) return null;

  const notes: ListNote[] = [];
  const wanted = [];
  let missing = 0;
  for (const entry of index.entries.values()) {
    if (!isNotePath(entry.path) || !inFolder(entry.path, folder, subfolders)) continue;
    if (entry.encrypted === true) continue;
    if (!entry.body) {
      missing += 1;
      continue;
    }
    const known = memo.notes.get(entry.path);
    if (known !== undefined && known.etag === entry.etag) notes.push(known.note);
    else wanted.push(entry);
  }
  for (let at = 0; at < wanted.length; at += READ_BATCH) {
    const batch = wanted.slice(at, at + READ_BATCH);
    const bodies = await Promise.all(batch.map((entry) => mirroredBodyAt(store, scope, workspaceId, entry)));
    if (ended()) return null;
    batch.forEach((entry, n) => {
      const body = bodies[n];
      if (body === null || body === undefined) {
        missing += 1;
        return;
      }
      const note: ListNote = {
        path: entry.path,
        ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
        properties: noteProperties(body) as Record<string, PropertyValue>,
        heading: noteHeading(body) as string | null,
        // What a folder page draws under a project's title; see `folderPage/lede.ts`.
        lede: noteLede(body),
      };
      memo.notes.set(entry.path, { etag: entry.etag, note });
      notes.push(note);
    });
  }
  // A note gone from the index is gone from memory too, not kept until a forget.
  for (const path of [...memo.notes.keys()]) {
    if (!index.entries.has(path)) memo.notes.delete(path);
  }
  return { notes, complete: missing === 0 && index.listedComplete !== false };
}
