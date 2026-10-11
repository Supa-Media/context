/**
 * The chaos score in the app: how organized a workspace is, from 0 (calm) to
 * 100 (chaos), lower is better (decided by the owner, 2026-10-10;
 * `docs/decisions/chaos-score.md`). The numbers are the server's
 * (`api.functions.chaosScore.chaosScore`, scored by `apps/mcp/src/chaos/
 * rubric.js`); this module only words them, and decides when a surface has
 * something to say. Pure: no React, no clock.
 *
 * It reports. No line here asks anybody to tidy: people, or their agents, do
 * that when they choose to.
 */

import { displayPath } from "../console/files/paths";

export interface ChaosFolder {
  folder: string;
  items: number;
  chaos: number;
}

/** What `chaosScore` answers; mirrors `ChaosScoreResult` in `apps/convex`. */
export interface ChaosScore {
  kind: "chaosScore";
  /** False until the workspace has been scored: then nothing is drawn. */
  available: boolean;
  score: number | null;
  word: string | null;
  weekAgo: number | null;
  /** The folders that would calm the score most, biggest first. */
  folders: ChaosFolder[];
  longNotes: { path: string; lines: number }[];
  /** The folder asked about, when one was. */
  folder: ChaosFolder | null;
}

export type ChaosWord = "calm" | "fine" | "crowded" | "chaotic";

/** How many biggest wins the panel lists. */
export const WINS_SHOWN = 5;

/** Past this a folder page shows its chip: the rubric's "fine" ends here. */
const CHIP_FROM = 30;

/** The figure's untangling, 0 the full scribble and 1 the calm #. */
export function chaosToT(chaos: number): number {
  if (!Number.isFinite(chaos)) return 0;
  return 1 - Math.min(100, Math.max(0, chaos)) / 100;
}

/** The rubric's word (`chaosWord` in `rubric.js`): ≤10 calm, ≤30 fine, ≤60 crowded. */
export function chaosWord(chaos: number): ChaosWord {
  if (chaos <= 10) return "calm";
  if (chaos <= 30) return "fine";
  if (chaos <= 60) return "crowded";
  return "chaotic";
}

/** The number people read: whole, 0 to 100. */
export function shownScore(chaos: number): number {
  return Math.round(Math.min(100, Math.max(0, chaos)));
}

/** Whether there is a score to show at all; not scored yet draws nothing. */
export function scoreShown(result: ChaosScore | null | undefined): result is ChaosScore & { score: number } {
  return result != null && result.available && typeof result.score === "number";
}

/**
 * The score against a week ago. Lower is calmer, so ↓ is the better way.
 * Nothing when a week ago is unknown or reads the same once rounded.
 */
export function trendAgainst(
  score: number | null,
  weekAgo: number | null,
): { arrow: "↓" | "↑"; better: boolean; label: string } | null {
  if (score === null || weekAgo === null) return null;
  const delta = shownScore(score) - shownScore(weekAgo);
  if (delta === 0) return null;
  const better = delta < 0;
  return { arrow: better ? "↓" : "↑", better, label: `${better ? "down" : "up"} ${Math.abs(delta)} from a week ago` };
}

export function itemsLabel(items: number): string {
  return items === 1 ? "1 item" : `${items} items`;
}

/** Whether a folder counts as thin: under four items, and the rubric charged it for that. */
function isThin(folder: { items: number; chaos: number }): boolean {
  return folder.items < 4 && folder.chaos > 0;
}

/** One line on what a folder's count means; the wording is `folderHint` in `apps/mcp/src/chaos/report.js`. */
export function folderHint(items: number, chaos: number): string {
  if (isThin({ items, chaos })) return items === 0 ? "only its about note" : "thin: calm is 4 to 5";
  if (items <= 5) return "calm";
  if (items <= 10) return "fine";
  return `${chaosWord(chaos)}: calm is 4 to 5, 10 is average`;
}

/** A folder's name as the tree shows it, the root named. */
export function folderLabel(folder: string): string {
  return folder === "" ? "Top level" : displayPath(folder);
}

/** A folder page shows its chip only past fine, or when it is thin. */
export function chipShows(folder: ChaosFolder | null | undefined): folder is ChaosFolder {
  return folder != null && (folder.chaos > CHIP_FROM || isThin(folder));
}

/** "12 items · crowded", or "2 items · thin". */
export function chipLabel(folder: ChaosFolder): string {
  return `${itemsLabel(folder.items)} · ${isThin(folder) ? "thin" : chaosWord(folder.chaos)}`;
}

/** The panel's biggest wins: the server's order, at most five, nothing already calm. */
export function biggestWins(result: ChaosScore): ChaosFolder[] {
  return result.folders.filter((folder) => folder.chaos > 0).slice(0, WINS_SHOWN);
}

/** How it's scored, in one paragraph, from the rubric's header. */
export const HOW_SCORED =
  "Each folder is scored by what is directly in it. Four or five items is calm, ten is average, and more climbs from there. " +
  "Thin folders count too: one or two items would sit better somewhere else. " +
  "A run of up to 30 dated or numbered notes counts as one item. " +
  "Notes past 1,000 lines count on their own, except meetings. Archive is never scored. " +
  "The workspace's number is the average over every note, so a big folder weighs what it holds.";

/**
 * The shape of the loaded tree, folder by folder: which paths each loaded
 * listing holds. The score moves when the tree does, and this is how the app
 * tells — see `treeChanged`.
 */
export function treeShape(
  listings: Readonly<Record<string, { entries: readonly { path: string }[] } | undefined>>,
): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [folder, listing] of Object.entries(listings)) {
    if (listing === undefined) continue;
    shape[folder] = listing.entries
      .map((entry) => entry.path)
      .sort()
      .join("\n");
  }
  return shape;
}

/**
 * Whether a folder already loaded gained, lost or moved something. A folder
 * loaded for the first time is not a change: opening the tree must not ask
 * for the score again.
 */
export function treeChanged(before: Record<string, string>, after: Record<string, string>): boolean {
  for (const [folder, paths] of Object.entries(before)) {
    if (after[folder] !== paths) return true;
  }
  return false;
}
