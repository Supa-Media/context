/**
 * A folder List or Board's notes, from the tree's properties table: each
 * note's front matter, heading and first paragraph in one query, instead of a
 * read of every note from the bucket (decided by the owner, 2026-10-09; see
 * `apps/mcp/src/tree/props.js`).
 *
 * **Privacy is decided here, exactly as a read decides it.** The table holds
 * no visibility. Every row is put through `canSee` over the live `privacy.md`
 * before any of its values is used, so a team reader is never handed a private
 * note's path, status or "it is encrypted", and a folder the reader cannot see
 * answers as an empty one.
 *
 * **A stale row is read again, never served.** A row parsed at another version
 * than its tree row (a save the table has not caught up with) is re-read from
 * the bucket through `readFiles`, which re-asks `canSee`, and its row fixed,
 * before the answer goes out. More stale rows on a page than `STALE_READ_CAP`
 * (a table never filled) and the answer is `available: false`: the caller
 * reads the folder from the bucket as before, and a fill pass is scheduled.
 */

import { canSee } from "../privacy";
import type { Clearance } from "../clearance";
import { type FileStore, READ_BATCH_PATHS, loadPrivacyState, readFiles } from "../fileOps";
import { folderVisibleAtScope } from "../fileOps/listing";
import { requireFolderPath } from "../fileOps/paths";
import { readTreeState } from "../../../../mcp/src/tree/table.js";
import { FOLDER_PAGE_ROWS, folderPropRows, propWriteStatement, propsOf } from "../../../../mcp/src/tree/props.js";
import type { ProjectionClient } from "../fileOps";

/** Stale rows one page may re-read before the table is not worth asking. */
export const STALE_READ_CAP = 200;

/** `readFiles` batches in flight at once while re-reading stale rows. */
const STALE_READ_PARALLEL = 4;

export interface FolderNotesResult {
  kind: "folderNotes";
  /** False: the table cannot answer yet; read the folder from the bucket. */
  available: boolean;
  /** Each visible note: `props` is `{ properties, heading, lede }` as JSON. */
  notes: { path: string; updatedAt?: number; props: string }[];
  /** Ask again after this path; null when this was the last page. */
  cursor: string | null;
  /** Visible notes that could not be read this time: a gap, not an absence. */
  missing: string[];
  /** A fill pass would help: the caller schedules one. */
  fill: boolean;
}

const unavailable = (fill: boolean): FolderNotesResult => ({
  kind: "folderNotes",
  available: false,
  notes: [],
  cursor: null,
  missing: [],
  fill,
});

function inFolder(path: string, prefix: string, subfolders: boolean): boolean {
  const rest = path.slice(prefix.length);
  if (rest.split("/").some((segment) => segment.startsWith("."))) return false;
  return subfolders || !rest.includes("/");
}

export async function folderNotesFromTable(
  store: FileStore,
  client: ProjectionClient,
  operation: { folder: string; subfolders: boolean; cursor?: string },
  clearance: Clearance,
): Promise<FolderNotesResult> {
  const folder = requireFolderPath(operation.folder);
  const prefix = folder === "" ? "" : `${folder}/`;
  let rows: Awaited<ReturnType<typeof folderPropRows>>;
  try {
    const tree = await readTreeState(client);
    // A table not yet whole, or one a change was too big for, could miss notes.
    if (!tree.ready || tree.unsupported || tree.dirty) return unavailable(false);
    rows = await folderPropRows(client, { folder, after: operation.cursor, limit: FOLDER_PAGE_ROWS });
  } catch {
    // No props table yet, or a database that cannot be read: the bucket answers.
    return unavailable(true);
  }
  const state = await loadPrivacyState(store);
  if (folder !== "" && !folderVisibleAtScope(folder, clearance, state.rules, state.overrides)) {
    return { kind: "folderNotes", available: true, notes: [], cursor: null, missing: [], fill: false };
  }
  const cursor = rows.length >= FOLDER_PAGE_ROWS ? rows[rows.length - 1]!.path : null;
  const visible = rows.filter(
    (row) =>
      row.path.startsWith(prefix) &&
      inFolder(row.path, prefix, operation.subfolders) &&
      canSee(row.path, clearance.scope, state.rules, state.overrides, clearance.names),
  );
  const stale = visible.filter((row) => row.stale);
  if (stale.length > STALE_READ_CAP) return unavailable(true);

  // Re-read what changed since it was parsed, plain (one GET a note), and fix its row.
  const fresh = new Map<string, string | null>();
  const gone = new Set<string>();
  const missing: string[] = [];
  const batches: string[][] = [];
  for (let at = 0; at < stale.length; at += READ_BATCH_PATHS) {
    batches.push(stale.slice(at, at + READ_BATCH_PATHS).map((row) => row.path));
  }
  const versions = new Map(stale.map((row) => [row.path, row.etag]));
  const writes: { sql: string; params: unknown[] }[] = [];
  const reader = async () => {
    for (let batch = batches.shift(); batch !== undefined; batch = batches.shift()) {
      for (const result of await readFiles(store, { paths: batch, clearance, plain: true })) {
        if (result.outcome === "read") {
          const props = propsOf(result.note.text);
          fresh.set(result.path, props === null ? null : JSON.stringify(props));
          // At the tree's version, as a fill pass records it: if the note
          // changed again after the tree saw it, the next read parses it again.
          writes.push(propWriteStatement(result.path, versions.get(result.path) ?? null, result.note.text));
        } else if (result.outcome === "deferred" || result.code !== "FILE_NOT_FOUND") {
          missing.push(result.path);
        } else {
          // Gone since the tree saw it: not a row.
          gone.add(result.path);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STALE_READ_PARALLEL, batches.length) }, reader));
  if (writes.length > 0) await client.runAll(writes).catch(() => {});

  const notes: FolderNotesResult["notes"] = [];
  for (const row of visible) {
    let props: string | null;
    if (row.stale) {
      // Gone, or a gap already in `missing`.
      if (gone.has(row.path) || !fresh.has(row.path)) continue;
      props = fresh.get(row.path) ?? null;
    } else {
      props = row.encrypted ? null : row.props;
    }
    // Encrypted notes are left out, as from the bucket: their front matter is sealed.
    if (props === null) continue;
    notes.push({ path: row.path, ...(row.uploaded === null ? {} : { updatedAt: row.uploaded }), props });
  }
  return { kind: "folderNotes", available: true, notes, cursor, missing, fill: false };
}
