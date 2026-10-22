/**
 * "Is that name taken?", answered from the Convex tree (step 3 of the
 * convex-only plan, `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Every write that has to know whether a name is free (a move's or a copy's
 * destination, an archive's or a duplicate's free name, a new folder, a
 * restore) used to ask the bucket: one GET per name, or a listing. The owner
 * decided on 2026-10-13 that nothing but opening and editing a note reads the
 * bucket, so these ask the tree's rows, folded through the workspace's pending
 * moves exactly as every listing draws them (`moveOverlay.ts`).
 *
 * Names only, and **unfiltered**: a name taken by a note this caller may not
 * see is taken. What a caller is told about it is decided by the caller with
 * `canSee`, as it was decided about the bucket's answer. The rows can lag the
 * bucket by the seconds a gateway touch takes, or until the next sweep for a
 * file written past us; the atomic truth on storage that has it is the write
 * itself (`onlyIf: { absent: true }`), and on storage that has not it is this
 * answer alone (`fileOps/treeChecks.ts`).
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";
import { logicalPath, physicalCandidates } from "./movePaths";
import type { PendingMove } from "./moveOverlay";
import { drawnMoves } from "./rowMoveChunks";

/** Names one ask may carry. */
export const TAKEN_PATHS = 100;

/** Rows a folder test reads under one physical prefix before it calls the name taken anyway. */
const FOLDER_SCAN = 200;

export interface TakenAnswer {
  /** The asked paths a live file sits at. */
  files: string[];
  /** The asked paths something live sits under (`path/…`). */
  folders: string[];
}

/** One past every key under `prefix/` in key order: `/` is 0x2F, `0` is 0x30. */
function pastFolder(prefix: string): string {
  return `${prefix}0`;
}

async function liveFileAt(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<boolean> {
  const row = await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .first();
  return row !== null && row.kind === "file" && row.goneAt === undefined;
}

/**
 * Whether a live file under physical `source/` folds to somewhere under
 * `logical/`. A row a pending move is carrying elsewhere does not count; past
 * `FOLDER_SCAN` rows that all fold away, the name is called taken, which only
 * ever refuses a write.
 */
async function liveUnder(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  source: string,
  logical: string,
  moves: readonly PendingMove[],
): Promise<boolean> {
  const rows = db
    .query("nodes")
    .withIndex("by_workspace_path", (q) =>
      q.eq("workspaceId", workspaceId).gte("path", `${source}/`).lt("path", pastFolder(source)),
    );
  let scanned = 0;
  for await (const row of rows) {
    scanned += 1;
    if (row.kind === "file" && row.goneAt === undefined && (logicalPath(row.path, moves) as string).startsWith(`${logical}/`)) {
      return true;
    }
    if (scanned >= FOLDER_SCAN) return true;
  }
  return false;
}

/** Whether something live is drawn at or under `logical`, through `moves`. */
async function takenAt(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  logical: string,
  moves: readonly PendingMove[],
): Promise<{ file: boolean; folder: boolean }> {
  const candidates = physicalCandidates(logical, moves) as string[];
  let file = false;
  for (const candidate of candidates) {
    if (await liveFileAt(db, workspaceId, candidate)) {
      file = true;
      break;
    }
  }
  let folder = false;
  for (const candidate of candidates) {
    if (await liveUnder(db, workspaceId, candidate, logical, moves)) {
      folder = true;
      break;
    }
  }
  // A pending move whose new name is inside `logical` draws its thing there.
  for (let index = 0; !folder && index < moves.length; index += 1) {
    const move = moves[index]!;
    if (!(logicalPath(move.to, moves.slice(index + 1)) as string).startsWith(`${logical}/`)) continue;
    for (const source of physicalCandidates(move.from, moves.slice(0, index)) as string[]) {
      const fileThere =
        (logicalPath(source, moves) as string).startsWith(`${logical}/`) && (await liveFileAt(db, workspaceId, source));
      if (fileThere || (await liveUnder(db, workspaceId, source, logical, moves))) {
        folder = true;
        break;
      }
    }
  }
  return { file, folder };
}

/** Which of `paths` the tree draws a file at, and which it draws a folder at. Reads only rows. */
export async function treeTaken(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  paths: readonly string[],
): Promise<TakenAnswer> {
  const moves = await drawnMoves(db, workspaceId);
  const answer: TakenAnswer = { files: [], folders: [] };
  for (const path of new Set(paths.slice(0, TAKEN_PATHS))) {
    if (path === "") continue;
    const taken = await takenAt(db, workspaceId, path, moves);
    if (taken.file) answer.files.push(path);
    if (taken.folder) answer.folders.push(path);
  }
  return answer;
}
