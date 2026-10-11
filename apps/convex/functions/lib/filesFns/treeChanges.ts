/**
 * What changed in a context's tree since a device last synced, judged for the
 * person asking — the desktop and phone apps' catch-up, instead of a walk of
 * the whole tree every time they come back.
 *
 * The rows are `tree_log`'s (`apps/mcp/src/tree/table.js`, "What changed
 * since"). Every decision about who may hear of one is made here, and it is
 * made the way the rest of the product makes it:
 *
 *  - **A key that is there** is an entry exactly when `canSee` over the live
 *    `privacy.md` says so, with `describeFile`'s fields, as `syncManifest`
 *    would draw it. A key the reader cannot see is left out, never reported.
 *  - **A key that left** cannot be judged by today's `privacy.md`: a delete
 *    forgets the exception that held a note back (`forgetPrivacy`) and a move
 *    takes it along (`movedOverrides`), so asking now would answer with the
 *    folder's default and tell a member the name of a private note that was
 *    deleted. It is reported only to a reader among the tree-hint audiences
 *    its writer recorded from the manifest *before* the change — the
 *    audiences that could see it — and, where nobody recorded any, only to
 *    the owner, who could see everything. A member's copy then keeps such a
 *    row until its next full walk; that is the safe direction.
 *  - **A change to `privacy.md`** can widen or narrow anything without a key
 *    moving, so the reader passes the version its copy was judged by, and any
 *    other version answers `full`: walk again. So does a log that does not
 *    reach back to `since`, and a context with no table.
 *
 * A folder is named the way `syncManifest` names one (`folderVisibleAtScope`
 * over every key's ancestors); a folder is reported gone only when it is an
 * ancestor of a key this reader was told left — a name they already had —
 * and the table holds nothing under it.
 */

import { audiencesOf } from "../treeAudiences";
import { type Clearance } from "../clearance";
import { canSee, isPlumbing, visibilityOf } from "../privacy";
import { type FileStore, loadPrivacyState, parentOf, type ProjectionClient } from "../fileOps";
import { describeFile, folderVisibleAtScope } from "../fileOps/listing";
import type { ManifestEntry, ManifestFolder } from "../fileOps";
import { readTreeState } from "../../../../mcp/src/tree/table.js";
import {
  CHANGE_OVERLAP_MS,
  CHANGE_PAGE_ROWS,
  changesReachBack,
  foldersStillHeld,
  listTreeChanges,
} from "../../../../mcp/src/tree/changes.js";
import type { TreeChangesResult } from "./operationTypes";

interface LogRow {
  path: string;
  at: number;
  gone: boolean;
  audiences: string[] | null;
  etag?: string;
  size?: number;
  uploaded?: number;
}

export async function treeChanges(
  store: FileStore,
  client: ProjectionClient,
  operation: { since: number; after?: string; privacy?: string },
  clearance: Clearance,
  options: { pageRows?: number } = {},
): Promise<TreeChangesResult> {
  const after = operation.after ?? "";
  const full = (privacy: string | null = null, manifestUsable = true): TreeChangesResult => ({
    kind: "treeChanges",
    full: true,
    entries: [],
    folders: [],
    gone: [],
    goneFolders: [],
    since: operation.since,
    after,
    more: false,
    privacy,
    manifestUsable,
  });

  let tree;
  try {
    tree = await readTreeState(client);
  } catch {
    return full();
  }
  if (!changesReachBack(tree, operation.since) || tree.now === null) return full();
  const state = await loadPrivacyState(store);
  const manifestUsable = state.text !== null && !state.invalid;
  if (operation.privacy === undefined || state.etag === null || state.etag !== operation.privacy) {
    return full(state.etag, manifestUsable);
  }

  const pageRows = options.pageRows ?? CHANGE_PAGE_ROWS;
  let rows: LogRow[];
  try {
    rows = (await listTreeChanges(client, { since: operation.since, after, limit: pageRows })) as LogRow[];
  } catch {
    return full(state.etag, manifestUsable);
  }

  const reader = new Set(audiencesOf(clearance.scope, [...clearance.names].map((name) => name.replace(/^@/, ""))));
  const entries: ManifestEntry[] = [];
  const gone: string[] = [];
  const folders = new Map<string, ManifestFolder>();
  const asked = new Set<string>([""]);
  const nameFolders = (key: string) => {
    let at = key.endsWith("/") ? key.replace(/\/+$/, "") : parentOf(key);
    while (at !== "" && !asked.has(at)) {
      asked.add(at);
      if (folderVisibleAtScope(at, clearance, state.rules, state.overrides)) {
        folders.set(at, { path: at, visibility: visibilityOf(at, state.rules) });
      }
      at = parentOf(at);
    }
  };

  for (const row of rows) {
    if (isPlumbing(row.path)) continue;
    if (row.gone) {
      const told = clearance.scope === "private" || (row.audiences ?? []).some((audience) => reader.has(audience));
      if (told) gone.push(row.path);
      continue;
    }
    nameFolders(row.path);
    if (!canSee(row.path, clearance.scope, state.rules, state.overrides, clearance.names)) continue;
    const described = describeFile(row.path, state.rules, state.overrides);
    entries.push({
      path: row.path,
      ...(row.etag === undefined ? {} : { etag: row.etag }),
      ...(row.size === undefined ? {} : { size: row.size }),
      ...(row.uploaded === undefined ? {} : { updatedAt: row.uploaded }),
      visibility: described.visibility,
      inherited: described.inherited,
      exception: described.exception,
      readOnly: described.readOnly,
    });
  }

  // The folders of what left: still there, or gone with it.
  const touched = new Set<string>();
  for (const path of gone) {
    let at = path.endsWith("/") ? path.replace(/\/+$/, "") : parentOf(path);
    while (at !== "" && !touched.has(at)) {
      touched.add(at);
      at = parentOf(at);
    }
  }
  const goneFolders: string[] = [];
  const unsettled = [...touched].filter((folder) => !folders.has(folder));
  const held = unsettled.length === 0 ? new Set<string>() : await foldersStillHeld(client, unsettled).catch(() => null);
  if (held === null) return full(state.etag, manifestUsable);
  for (const folder of unsettled) {
    if (!held.has(folder)) goneFolders.push(folder);
    else if (folderVisibleAtScope(folder, clearance, state.rules, state.overrides)) {
      folders.set(folder, { path: folder, visibility: visibilityOf(folder, state.rules) });
    }
  }

  const more = rows.length >= pageRows;
  const last = rows[rows.length - 1];
  return {
    kind: "treeChanges",
    full: false,
    entries,
    folders: [...folders.values()],
    gone,
    goneFolders,
    // A finished catch-up resumes a little behind the table's clock, so a
    // write that read the clock before this page and committed after it is
    // read next time (`CHANGE_OVERLAP_MS`).
    since: more && last ? last.at : tree.now - CHANGE_OVERLAP_MS,
    after: more && last ? last.path : "",
    more,
    privacy: state.etag,
    manifestUsable,
  };
}
