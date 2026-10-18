/**
 * A folder List or Board's notes, from the Convex tree's facts: each note's
 * front matter, heading and first paragraph from its own row
 * (`lib/nodes/facts.ts`), instead of a read of every note from the bucket
 * (decided by the owner, 2026-10-09; moved from the search database's
 * `tree_props` on 2026-10-13, which phase 7 retired).
 *
 * **Privacy is decided here, exactly as a read decides it.** The rows hold no
 * visibility. Every note is put through `canSee` over the live `privacy.md`
 * before any of its values is used, so a team reader is never handed a private
 * note's path, status or "it is encrypted", and a folder the reader cannot see
 * answers as an empty one.
 *
 * **From the Convex tree, no note read** (`folderNotesFromNodes`, decided by
 * the owner, 2026-10-13). A row parsed at another version than the tree's
 * shows what was last parsed until the facts fill catches up; a note never
 * parsed is a gap (`missing`).
 */

import { canSee } from "../privacy";
import type { Clearance } from "../clearance";
import { type FileStore, loadPrivacyState } from "../fileOps";
import { folderVisibleAtScope } from "../fileOps/listing";
import { requireFolderPath } from "../fileOps/paths";
import { servedMoves } from "../nodes/manifestStore";
import { physicalCandidates } from "../../../../mcp/src/moves/queued.js";

/** Notes one page of a List asks for: a bound on one answer. */
export const FOLDER_PAGE_ROWS = 2_000;

export interface FolderNotesResult {
  kind: "folderNotes";
  /** False: the facts cannot answer yet; the List is drawn incomplete, never read from the bucket. */
  available: boolean;
  /** Each visible note: `props` is `{ properties, heading, lede }` as JSON; `size` its bytes, when the tree knows it. */
  notes: { path: string; updatedAt?: number; size?: number; props: string }[];
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

/** Where a note's front matter is read from, for a List whose notes the Convex tree names. */
export interface PropSource {
  /** The rows of exactly these notes, keyed by path; a note with none is absent. */
  rows(paths: string[]): Promise<Map<string, { version: string | null; encrypted: boolean; props: string | null }>>;
}

/**
 * One page of a folder's List from the Convex tree (`servedNodesStore`):
 * which notes sit in the folder, and at which version, are the rows; only the
 * front matter comes from `source` (the rows' own props, `factPropSource`),
 * and a row parsed at another version than the tree's is read again.
 * `privacy.md` is the tree's mirror, through the store.
 */
export async function folderNotesFromNodes(
  served: FileStore,
  source: PropSource,
  operation: { folder: string; subfolders: boolean; cursor?: string },
  clearance: Clearance,
): Promise<FolderNotesResult> {
  const folder = requireFolderPath(operation.folder);
  const prefix = folder === "" ? "" : `${folder}/`;
  const state = await loadPrivacyState(served);
  if (folder !== "" && !folderVisibleAtScope(folder, clearance, state.rules, state.overrides)) {
    return { kind: "folderNotes", available: true, notes: [], cursor: null, missing: [], fill: false };
  }
  const listing = await served.list({
    prefix,
    limit: FOLDER_PAGE_ROWS,
    ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
  });
  const cursor = listing.truncated && typeof listing.cursor === "string" ? listing.cursor : null;
  const tree = (listing.objects ?? []).filter(
    (object) =>
      object.key.endsWith(".md") &&
      inFolder(object.key, prefix, operation.subfolders) &&
      canSee(object.key, clearance.scope, state.rules, state.overrides, clearance.names),
  );
  // While a folder move is pending the rows are listed at the names the tree
  // draws, and a note's front matter is still filed under the key it sits at
  // in the bucket: each is looked up at every key it may still sit at, so a
  // List of a moving folder answers from the facts rather than re-reading
  // every note (and promoting it) or falling back to the D1 table.
  const moves = servedMoves(served);
  const candidates = new Map(
    tree.map((object) => [object.key, moves.length === 0 ? [object.key] : (physicalCandidates(object.key, [...moves]) as string[])]),
  );
  let props: Awaited<ReturnType<PropSource["rows"]>>;
  try {
    const found = await source.rows([...new Set([...candidates.values()].flat())]);
    props = new Map();
    for (const object of tree) {
      const etag = (object as { etag?: unknown }).etag;
      const held = candidates.get(object.key)!.map((key) => found.get(key)).filter((row) => row !== undefined);
      const row = held.find((candidate) => candidate!.version === etag) ?? held[0];
      if (row !== undefined) props.set(object.key, row);
    }
  } catch {
    // No props yet, or a source that cannot be read: not available, and a fill is asked for.
    return unavailable(true);
  }
  const visible: PropRow[] = tree.map((object) => {
    const meta = object as { key: string; etag?: unknown; size?: unknown; uploaded?: Date };
    const etag = typeof meta.etag === "string" ? meta.etag : null;
    const uploaded = meta.uploaded;
    const row = props.get(object.key);
    return {
      path: object.key,
      etag,
      uploaded: uploaded === undefined ? null : new Date(uploaded).getTime(),
      size: typeof meta.size === "number" && Number.isFinite(meta.size) ? meta.size : null,
      stale: row === undefined || (etag !== null && etag !== row.version),
      encrypted: row?.encrypted === true,
      props: row?.props ?? null,
    };
  });
  return answerFromFacts(visible, cursor);
}

/**
 * Visible rows to an answer, reading no note (decided by the owner,
 * 2026-10-13: nothing before opening a note reads storage). A note whose
 * facts were parsed at an older version shows what was last parsed, as the
 * List drew it a moment ago; the facts fill the change started catches it up,
 * and the List redraws. A note never parsed yet is `missing`, a gap the List
 * says it may have, and `fill` asks the caller to start the facts fill.
 */
export function answerFromFacts(visible: readonly PropRow[], cursor: string | null): FolderNotesResult {
  const notes: FolderNotesResult["notes"] = [];
  const missing: string[] = [];
  let fill = false;
  for (const row of visible) {
    if (row.stale) fill = true;
    // Encrypted notes are left out, as from the bucket: their front matter is sealed.
    if (row.encrypted) continue;
    // Never parsed (no facts for it yet): a gap, never an empty note.
    if (row.props === null) {
      missing.push(row.path);
      fill = true;
      continue;
    }
    notes.push({
      path: row.path,
      ...(row.uploaded === null ? {} : { updatedAt: row.uploaded }),
      ...(row.size === null || row.size === undefined ? {} : { size: row.size }),
      props: row.props,
    });
  }
  return { kind: "folderNotes", available: true, notes, cursor, missing, fill };
}

/** One note of the page: its tree version, and the props its row holds, if any. */
interface PropRow {
  path: string;
  etag: string | null;
  uploaded: number | null;
  /** The note's bytes, as the tree lists them; the AI tab draws a prompt's size from it. */
  size?: number | null;
  stale: boolean;
  encrypted: boolean;
  props: string | null;
}
