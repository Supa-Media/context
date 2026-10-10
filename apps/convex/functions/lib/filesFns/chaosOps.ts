/**
 * The chaos score, from the console's side: kept current as the console
 * changes notes, and read back for the app.
 *
 * What the score is and how it is kept is `apps/mcp/src/chaos/` (the rubric
 * the owner set on 2026-10-10, scored per folder in the tree database). This
 * file is the control plane's three uses of it, each inside the credential
 * barrier beside the tree table it lives in (`treeTableOps.ts`):
 *
 *  - **After a re-check** (`touchTree`), the folders the change touched are
 *    rescored, so the number the app shows moves with the change.
 *  - **After the properties fill** has read notes, every folder is scored
 *    again: that is where a note's length comes from, and where a table that
 *    was never scored gets its first numbers.
 *  - **`chaosScore`** answers the app: the score for this reader, a week ago,
 *    the folders that would calm it most, the longest notes, and one folder's
 *    own numbers for the chip on its page.
 *
 * ## Two audiences, never more
 *
 * The table holds an owner's numbers and a team member's, the latter over
 * only the notes `privacy.md` shows the team. A member is answered from the
 * team numbers, and a folder is named to them only where a note they may
 * open sits beneath it. A note held back from the team is neither counted
 * nor named, so the score never tells a member that something exists.
 */

import { chaosFullPass, chaosReady, chaosSummary, rescoreChange } from "../../../../mcp/src/chaos/table.js";
import { chaosWord } from "../../../../mcp/src/chaos/rubric.js";
import type { Clearance } from "../clearance";
import { canSee } from "../privacy";
import { type FileStore, loadPrivacyState, type ProjectionClient } from "../fileOps";

export type ChaosFolder = { folder: string; items: number; chaos: number };

export type ChaosScoreResult = {
  kind: "chaosScore";
  /** False until the workspace has been scored, or where it has no tree database. */
  available: boolean;
  score: number | null;
  word: string | null;
  weekAgo: number | null;
  /** The folders that would calm the score most, biggest first. */
  folders: ChaosFolder[];
  longNotes: { path: string; lines: number }[];
  /** The folder that was asked about, or null when it is not scored for this reader. */
  folder: ChaosFolder | null;
};

export const NO_CHAOS: ChaosScoreResult = {
  kind: "chaosScore",
  available: false,
  score: null,
  word: null,
  weekAgo: null,
  folders: [],
  longNotes: [],
  folder: null,
};

/** Whether the team may see a key, by the live manifest. Null when it cannot be read. */
async function teamFilter(store: FileStore): Promise<((path: string) => boolean) | null> {
  const state = await loadPrivacyState(store);
  // An unreadable manifest is read as "everything private" by `canSee`
  // already; scoring by it would publish a wrong team number until the next
  // full pass, so wait for a manifest that parses.
  if (state.invalid) return null;
  return (path: string) => canSee(path, "team", state.rules, state.overrides);
}

/** Rescore the folders a console change touched. Never throws: the next full pass puts a miss right. */
export async function rescoreTouched(
  store: FileStore,
  client: ProjectionClient,
  touch: { paths: string[]; files: string[] },
): Promise<void> {
  try {
    if (!(await chaosReady(client))) return;
    const visibleToTeam = await teamFilter(store);
    if (visibleToTeam === null) return;
    await rescoreChange(client, { paths: touch.paths, files: touch.files, visibleToTeam, store });
  } catch {
    // A score is a derivative; a failed rescore is never a failed change.
  }
}

/**
 * Score every folder again once the properties fill has finished a pass
 * that read something, or when nothing has been scored yet.
 */
export async function chaosAfterFill(
  store: FileStore,
  client: ProjectionClient,
  props: { read: number; remaining: number } | null,
): Promise<void> {
  if (props === null || props.remaining > 0) return;
  try {
    if (props.read === 0 && (await chaosReady(client))) return;
    const visibleToTeam = await teamFilter(store);
    if (visibleToTeam === null) return;
    await chaosFullPass(client, { visibleToTeam });
  } catch {
    // As above.
  }
}

function folderOf(row: Record<string, unknown> | undefined, team: boolean): ChaosFolder | null {
  if (!row) return null;
  if (team && Number(row.team_exists) !== 1) return null;
  const weight = Number(team ? row.team_weight : row.weight);
  const sum = Number(team ? row.team_sum : row.sum);
  return {
    folder: String(row.folder),
    items: Number(team ? row.team_items : row.items),
    chaos: weight > 0 ? sum / weight : 0,
  };
}

/** The app's answer for one reader. */
export async function chaosScoreOf(
  store: FileStore,
  client: ProjectionClient,
  operation: { folder?: string },
  clearance: Clearance,
): Promise<ChaosScoreResult> {
  const team = clearance.scope !== "private";
  const state = team ? await loadPrivacyState(store) : null;
  const visible = (path: string) =>
    state === null ? true : canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
  const summary = await chaosSummary(client, { audience: team ? "team" : "all", visible });
  if (summary === null) return NO_CHAOS;
  let folder: ChaosFolder | null = null;
  if (operation.folder !== undefined) {
    const name = operation.folder.replace(/^\/+|\/+$/g, "");
    const [row] = await client.query("SELECT * FROM tree_chaos WHERE folder = ?1", [name]);
    folder = folderOf(row, team);
  }
  return {
    kind: "chaosScore",
    available: true,
    score: summary.score,
    word: chaosWord(summary.score),
    weekAgo: summary.weekAgo,
    folders: summary.folders.map((entry: ChaosFolder) => ({ folder: entry.folder, items: entry.items, chaos: entry.chaos })),
    longNotes: summary.longNotes,
    folder,
  };
}
