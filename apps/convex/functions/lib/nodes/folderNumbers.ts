/**
 * Taking the sort numbers off built-in folders, one workspace at a time
 * (owner, 2026-10-21: "need to get rid of the 1- 2- prefixes we've been
 * putting on folders"). New workspaces are laid out as `inbox`, `projects`,
 * `areas`, `resources` and `archive` (`folderRoles.cjs`, `DEFAULT_FOLDER`);
 * this renames the folders older workspaces were given (`0-inbox`,
 * `1-projects`, `9-archive`, …) to match.
 *
 * Which folders: every live folder at the root whose name is a job's name
 * with a number in front (`plainFolderName`), and every folder doing a job
 * wherever it was nested. A numbered folder further down that does no job is
 * somebody's own and is never touched.
 *
 * Each rename is the console's rename (`nodesMoveStart` through the move
 * barrier, at the owner's clearance), so the folder keeps its rows, ids,
 * rules and job, its Archive twin follows, and the settings that name it
 * (meetings, forwarded mail, Google) follow too. Nothing is guessed:
 *
 * - a folder whose plain name a sibling already has is left where it is and
 *   counted as a twin, so two folders are never merged by a migration;
 * - an unkeyed workspace is left alone, because there a rename is a byte
 *   move of every note under it;
 * - in a keyed one, a file row still read at its path (written by path
 *   after keying, such as a mail pass's attachment list) would make the row
 *   move refuse the whole folder ("unkeyed"), so it is pinned first, as
 *   hiding old copies pins them (`lib/oldCopies/folders.ts`): its key set to
 *   the path its bytes are at, so it reads the same after the rename. A
 *   refused rename takes the pins back;
 * - the plan is read again after every rename, so a folder renamed by an
 *   earlier one (an Archive twin, a nested job) is never moved twice.
 *
 * The answer is counts only: it is printed by a workflow in a public
 * repository.
 */

import { v } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx, DatabaseReader } from "../../../_generated/server";
import { ROW_ROLES, plainFolderName } from "@context/shared/src/folderRoles.cjs";
import type { OperationResult } from "../filesFns/operationTypes";
import { liveRowsDoing } from "./folderJobs";

/** Root rows read per workspace: far past any real root, a bound on a loop. */
const ROOT_ROWS = 2_000;
/** Renames one workspace's pass may make: five built-ins, their twins, and room to spare. */
const MAX_RENAMES = 30;

export interface FolderRename {
  from: string;
  to: string;
}

export interface FolderNumbersPlan {
  keyed: boolean;
  renames: FolderRename[];
  /** Numbered folders whose plain name a sibling already has. */
  twins: string[];
}

export const folderNumbersPlanValidator = v.object({
  keyed: v.boolean(),
  renames: v.array(v.object({ from: v.string(), to: v.string() })),
  twins: v.array(v.string()),
});

export interface FolderNumbersCounts {
  keyed: boolean;
  renamed: number;
  wouldRename: number;
  twins: number;
  /** Renames the barrier refused, by error code. */
  refused: Record<string, number>;
}

/** An error's words, with paths and quoted text removed: what a public job log may print. ASCII, so it can key a record. */
export function errorWords(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "...")
    .replace(/\S*[/\\]\S*/g, "<path>")
    .slice(0, 300);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

async function liveChildren(db: DatabaseReader, workspaceId: Id<"workspaces">, parentId: Id<"nodes"> | undefined): Promise<Doc<"nodes">[]> {
  const rows = await db
    .query("nodes")
    .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", parentId))
    .take(ROOT_ROWS);
  return rows.filter((row) => row.goneAt === undefined);
}

/** What this workspace's numbered built-in folders would be renamed to, read from the live rows. */
export async function planFolderNumbers(db: DatabaseReader, workspaceId: Id<"workspaces">, keyed: boolean): Promise<FolderNumbersPlan> {
  if (!keyed) return { keyed, renames: [], twins: [] };
  const candidates = new Map<string, Doc<"nodes">>();
  for (const row of await liveChildren(db, workspaceId, undefined)) {
    // A top-level row's path is its name.
    if (row.kind === "folder" && plainFolderName(row.name) !== null)
      candidates.set(row._id, { ...row, path: row.name });
  }
  for (const role of ROW_ROLES) {
    for (const row of await liveRowsDoing(db, workspaceId, role, 4)) {
      if (plainFolderName(row.name) !== null) candidates.set(row._id, row);
    }
  }
  // The folder doing a job claims the plain name before a stray of the same job's spelling.
  const ordered = [...candidates.values()].sort(
    (a, b) => Number(a.role === undefined) - Number(b.role === undefined) || a.path.localeCompare(b.path),
  );
  const renames: FolderRename[] = [];
  const twins: string[] = [];
  const claimed = new Map<string, Set<string>>();
  for (const row of ordered) {
    const plain = plainFolderName(row.name) as string;
    const parent = parentPath(row.path);
    const taken = claimed.get(parent) ?? new Set<string>();
    const siblings = await liveChildren(db, workspaceId, row.parentId);
    const twin =
      taken.has(plain.toLowerCase()) ||
      siblings.some((sibling) => sibling._id !== row._id && sibling.name.toLowerCase() === plain.toLowerCase());
    if (twin) {
      twins.push(row.path);
      continue;
    }
    taken.add(plain.toLowerCase());
    claimed.set(parent, taken);
    renames.push({ from: row.path, to: parent === "" ? plain : `${parent}/${plain}` });
  }
  return { keyed, renames, twins };
}

/** Pin every unkeyed file row under `folder`, a page at a time; answers the rows pinned. */
async function pinUnder(ctx: ActionCtx, workspaceId: Id<"workspaces">, folder: string): Promise<Id<"nodes">[]> {
  const pinned: Id<"nodes">[] = [];
  let after: string | undefined;
  for (;;) {
    const page: { pinned: Id<"nodes">[]; next: string | null } = await ctx.runMutation(
      internal.functions.folderNumbers.pinPage,
      { workspaceId, folder, ...(after === undefined ? {} : { after }) },
    );
    pinned.push(...page.pinned);
    if (page.next === null) return pinned;
    after = page.next;
  }
}

/**
 * One workspace's pass. `move` is the console's rename (the action passes
 * `runFileOperation`; a test passes the barrier with its own store).
 */
export async function dropFolderNumbersIn(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  move: (from: string, to: string) => Promise<OperationResult>,
  dryRun: boolean,
): Promise<FolderNumbersCounts> {
  const plan = (): Promise<FolderNumbersPlan> =>
    ctx.runQuery(internal.functions.folderNumbers.plan, { workspaceId }) as Promise<FolderNumbersPlan>;
  const first = await plan();
  const counts: FolderNumbersCounts = {
    keyed: first.keyed,
    renamed: 0,
    wouldRename: first.renames.length,
    twins: first.twins.length,
    refused: {},
  };
  if (dryRun || !first.keyed) return counts;
  const tried = new Set<string>();
  let current = first;
  for (let pass = 0; pass < MAX_RENAMES; pass += 1) {
    const next = current.renames.find((rename) => !tried.has(rename.from));
    if (next === undefined) break;
    tried.add(next.from);
    const pinned = await pinUnder(ctx, workspaceId, next.from);
    const result = await move(next.from, next.to);
    if (result.kind === "moveQueued" && result.queued) {
      counts.renamed += 1;
    } else {
      if (pinned.length > 0) await ctx.runMutation(internal.functions.folderNumbers.unpinRows, { ids: pinned });
      const refusedWith = result as { error?: string; message?: string };
      const code = refusedWith.error ?? "NOT_QUEUED";
      // The code alone does not say which refusal it was (CONFLICT is busy, unkeyed or changed alike).
      const key = refusedWith.message === undefined ? code : `${code}: ${errorWords(refusedWith.message)}`;
      counts.refused[key] = (counts.refused[key] ?? 0) + 1;
    }
    current = await plan();
  }
  counts.wouldRename = current.renames.filter((rename) => !tried.has(rename.from)).length;
  counts.twins = current.twins.length;
  return counts;
}
