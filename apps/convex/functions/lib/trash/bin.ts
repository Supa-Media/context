/**
 * What a keyed workspace's trash holds, read from its rows (decided by the
 * owner, 2026-10-17: "30 days, Trash page first"; `notes-by-id.md`,
 * "Emptying the trash").
 *
 * A keyed trash is a row move into `.context/trash/<stamp>/<path>`
 * (`lib/nodes/rowTrash.ts`). Each trash takes a stamp folder of its own (a
 * second in the same millisecond takes `<stamp>-2`), so one stamp folder is
 * one thing a person moved to the trash, and the stamp is when. It is erased
 * for good `TRASH_KEEP_DAYS` after that, rows and bytes together
 * (`functions/trash.ts`).
 *
 * What was trashed is read from the audit trail the trash writes
 * (`lib/nodes/trashTrail.ts`): `[note or folder, trash key]`. A trash with no
 * trail (one made before trails, or by a caller that writes none) answers the
 * deepest folder holding every note in it, or the one note.
 *
 * Nothing here asks who may see what: `functions/trash.ts` judges each item's
 * own name with `canSee` before answering anyone, by `rulesAsTrashed`.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";
import { TRASH_ROOT } from "../fileOps/store";
import { PrivacyOverrides, type PrivacyRule, type Visibility } from "../privacy";
import type { Rules } from "../nodes/log";
import { nodeAt, rowsAfter } from "../nodes/paths";

export const TRASH_KEEP_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
export const TRASH_KEEP_MS = TRASH_KEEP_DAYS * DAY;

/** Stamp folders one read lists: far more than a person trashes in 30 days, and a bound on the read. */
export const STAMP_SCAN = 1_000;
/** Rows read under one stamp folder: a trashed folder holds at most `ROW_MOVE_MAX` rows, plus the folders above it. */
export const GROUP_SCAN = 2_000;
/** How long after the stamp the trash's audit row may land: the trash writes it once the rows have moved. */
const TRAIL_WINDOW = 10 * 60 * 1000;

/** `2026-10-17T04-06-24-327Z`, or with a `-2` ... suffix: what `timestampSlug` writes, and when. */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?$/;

export function stampTimeOf(name: string): number | null {
  const match = STAMP.exec(name);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, ms] = match.map(Number);
  const at = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  return Number.isFinite(at) ? at : null;
}

/** When a trash made at `at` is erased for good. */
export function eraseAtOf(at: number): number {
  return at + TRASH_KEEP_MS;
}

/** `.context/trash/<stamp>` for a trash key anywhere under it, or null for any other path. */
export function stampFolderOf(path: string): string | null {
  if (!path.startsWith(`${TRASH_ROOT}/`)) return null;
  const stamp = path.slice(TRASH_ROOT.length + 1).split("/")[0];
  return stamp === "" ? null : `${TRASH_ROOT}/${stamp}`;
}

export interface StampFolder {
  row: Doc<"nodes">;
  /** `.context/trash/<stamp>`. */
  folder: string;
  at: number;
  eraseAt: number;
}

/** The live stamp folders of a workspace's trash, oldest first. A folder whose name is not a stamp is left alone. */
export async function stampFolders(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<StampFolder[]> {
  const root = await nodeAt(db, workspaceId, TRASH_ROOT);
  if (root === null) return [];
  const children = await db
    .query("nodes")
    .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", root._id))
    .take(STAMP_SCAN);
  const folders: StampFolder[] = [];
  for (const row of children) {
    if (row.goneAt !== undefined || row.kind !== "folder") continue;
    const at = stampTimeOf(row.name);
    if (at === null) continue;
    const folder = `${TRASH_ROOT}/${row.name}`;
    folders.push({
      row: { ...row, path: folder },
      folder,
      at,
      eraseAt: eraseAtOf(at),
    });
  }
  return folders.sort((a, b) => a.at - b.at || a.folder.localeCompare(b.folder));
}

/** Every row under a stamp folder (not the folder itself), live or not, in path order. */
export async function rowsUnder(db: DatabaseReader, workspaceId: Id<"workspaces">, folder: string): Promise<Doc<"nodes">[]> {
  return await rowsAfter(db, workspaceId, folder, undefined, GROUP_SCAN);
}

export interface TrashedItem {
  /** The trash key Restore takes back from: `.context/trash/<stamp>/<path>`. */
  trash: string;
  /** Where it was, and where Restore puts it. */
  path: string;
  kind: "file" | "folder";
  /** Who moved it there, when the trail says. */
  actorUserId: Id<"users"> | undefined;
}

/** What one stamp folder holds: the thing that was trashed, read from the trail, or from its rows. */
export async function trashedItemOf(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  stamp: StampFolder,
  rows: readonly Doc<"nodes">[],
): Promise<TrashedItem | null> {
  const live = rows.filter((row) => row.goneAt === undefined);
  const events = await db
    .query("auditEvents")
    .withIndex("by_workspace_at", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .gte("at", stamp.at)
        .lte("at", stamp.at + TRAIL_WINDOW),
    )
    .take(200);
  for (const event of events) {
    if (event.action !== "file.archive" || event.details?.trash !== true) continue;
    const key = event.paths[1];
    if (typeof key !== "string" || stampFolderOf(key) !== stamp.folder) continue;
    const row = live.find((candidate) => candidate.path === key);
    if (row === undefined) continue;
    return { trash: key, path: key.slice(stamp.folder.length + 1), kind: row.kind, actorUserId: event.actorUserId };
  }
  return fromRows(stamp.folder, live);
}

/** The deepest row holding every file in the trash, or the one file: what was trashed, when no trail says. */
function fromRows(folder: string, live: readonly Doc<"nodes">[]): TrashedItem | null {
  const files = live.filter((row) => row.kind === "file");
  if (files.length === 0) return null;
  if (files.length === 1)
    return { trash: files[0].path, path: files[0].path.slice(folder.length + 1), kind: "file", actorUserId: undefined };
  const parts = files.map((row) => row.path.split("/"));
  let shared = 0;
  while (parts.every((segments) => segments.length - 1 > shared && segments[shared] === parts[0][shared])) shared += 1;
  const trash = parts[0].slice(0, shared).join("/");
  if (trash.length <= folder.length) return null;
  return { trash, path: trash.slice(folder.length + 1), kind: "folder", actorUserId: undefined };
}

/**
 * The rules as they stood for what a stamp folder holds, before it was trashed.
 *
 * With privacy on rows, a note's or folder's own setting is on its row, and a
 * row trash takes the row (setting and all) to `.context/trash/<stamp>/<path>`.
 * Judged by the live rules alone, a private note in a shared folder would read
 * as the folder's, and a member would be shown it. So each rule under the
 * stamp folder is put back at its own name, over whatever holds that name now:
 * the trashed note is judged as it was. With privacy in the file, nothing is
 * under the trash and the rules come back as they are.
 */
export function rulesAsTrashed(live: Rules, folder: string): Rules {
  const under = `${folder}/`;
  const restored = (path: string) => (path.startsWith(under) ? path.slice(under.length) : null);
  const moved: PrivacyRule[] = [];
  for (const rule of live.rules) {
    const path = restored(rule.prefix);
    if (path !== null && path !== "") moved.push({ prefix: path, vis: rule.vis });
  }
  const movedOverrides = new Map<string, Visibility>();
  for (const [key, vis] of live.overrides) {
    const path = restored(key);
    if (path !== null && path !== "") movedOverrides.set(path, vis);
  }
  if (moved.length === 0 && movedOverrides.size === 0) return live;
  const shadowed = new Set(moved.map((rule) => rule.prefix));
  const rules = [...live.rules.filter((rule) => !shadowed.has(rule.prefix)), ...moved];
  const overrides = new PrivacyOverrides();
  for (const [key, vis] of live.overrides) if (!movedOverrides.has(key)) overrides.set(key, vis);
  for (const [key, vis] of movedOverrides) overrides.set(key, vis);
  return { rules, overrides };
}
