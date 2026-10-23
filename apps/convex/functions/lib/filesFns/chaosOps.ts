/**
 * The chaos score, from the console's side: the app's answer, counted at
 * read time from the Convex tree's keys with its facts.
 *
 * What the score is is `apps/mcp/src/chaos/` (the rubric the owner set on
 * 2026-10-10; `live.js` counts it from keys). This file answers the app's
 * `chaosScore` inside the credential barrier (`treeOps.ts`): the score for
 * this reader, a week ago, the folders that would calm it most, the longest
 * notes, and one folder's own numbers for the chip on its page. Until phase 7
 * of the tree migration the search database also kept the score per folder;
 * where the Convex facts cannot answer now, the score is `NO_CHAOS`, as for
 * a workspace with no search database.
 *
 * ## Two audiences, never more
 *
 * The score is counted for an owner and for a team member, the latter over
 * only the notes `privacy.md` shows the team. A member is answered from the
 * team numbers, and a folder is named to them only where a note they may
 * open sits beneath it. A note held back from the team is neither counted
 * nor named, so the score never tells a member that something exists.
 */

import { folderNumbers, liveSummary, liveTotals, scoreKeys } from "../../../../mcp/src/chaos/live.js";
import { logicalPath as queuedLogicalPath } from "../nodes/movePaths";
import { servedKeys, servedMoves } from "../nodes/manifestStore";
import { chaosWord } from "../../../../mcp/src/chaos/rubric.js";
import type { Clearance } from "../clearance";
import { canSee } from "../privacy";
import { type FileStore, loadPrivacyState } from "../fileOps";

export type ChaosFolder = { folder: string; items: number; chaos: number };

export type ChaosScoreResult = {
  kind: "chaosScore";
  /** False until the Convex facts have read every note, or where the tree does not serve. */
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

/**
 * Where a live count reads what the keys cannot say: the long notes, meetings
 * and contact reviews (`extras`, by bucket key), and the score some days ago:
 * the Convex facts (`functions/nodeChaos.ts`, through `factChaosSource`).
 */
export interface ChaosSource {
  extras(): Promise<Map<string, { lines: number | null; exempt: boolean; review: boolean }> | null>;
  weekAgo(audience: "all" | "team"): Promise<number | null>;
  /** Keep today's closing score for both audiences, where this source keeps it. */
  record?(totals: { all: number; team: number }): Promise<void>;
}

/**
 * The app's answer counted from the Convex tree's keys where it serves the
 * workspace (`apps/mcp/src/chaos/live.js`): the shape as drawn now, pending
 * moves folded in, with the rules from the tree's mirror. Only long notes,
 * meetings and contact reviews, and the score a week ago, come from
 * `source`. `null` when this cannot answer (the facts have not read every
 * note, rules that do not parse), and the app shows no score.
 */
export async function liveChaosScoreOf(
  served: FileStore,
  source: ChaosSource,
  operation: { folder?: string },
  clearance: Clearance,
): Promise<ChaosScoreResult | null> {
  const found = await source.extras();
  if (found === null) return null;
  const state = await loadPrivacyState(served);
  if (state.invalid) return null;
  const keys = await servedKeys(served);
  // The facts name notes by bucket key; the keys are drawn through pending moves.
  const moves = servedMoves(served);
  const extras = new Map<string, { lines: number | null; exempt: boolean; review: boolean }>();
  for (const [path, extra] of found) extras.set(moves.length === 0 ? path : (queuedLogicalPath(path, moves) as string), extra);
  const visibleToTeam = (path: string) => canSee(path, "team", state.rules, state.overrides);
  const folders = scoreKeys(keys, extras, visibleToTeam);
  const team = clearance.scope !== "private";
  const visible = (path: string) => canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
  const weekAgo = await source.weekAgo(team ? "team" : "all");
  if (source.record !== undefined) await source.record(liveTotals(folders)).catch(() => {});
  const summary = liveSummary(folders, extras, { team, present: new Set(keys), visible, weekAgo });
  const folder =
    operation.folder === undefined ? null : folderNumbers(folders, operation.folder.replace(/^\/+|\/+$/g, ""), team);
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
