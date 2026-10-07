/**
 * The words for the Search tab's indexing panel (`./MeaningIndexPanel`), over
 * `meaningIndexReport` (`apps/convex/functions/lib/adminFns/meaningIndexes.ts`).
 * Pure, so the copy is pinned by `adminMeaningIndexes.test.ts`.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import type { PillTone } from "../design";

export type MeaningIndexReport = FunctionReturnType<typeof api.functions.meaningAdmin.meaningIndexReport>;
export type MeaningIndexRow = MeaningIndexReport["rows"][number];

/** The pill beside a workspace. */
export function meaningStatePill(row: Pick<MeaningIndexRow, "status" | "enabled">): { label: string; tone: PillTone } {
  if (!row.enabled) return { label: "Turned off by owner", tone: "neutral" };
  switch (row.status) {
    case "ready":
      return { label: "Ready", tone: "ok" };
    case "backfilling":
      return { label: "Indexing", tone: "neutral" };
    case "provisioning":
      return { label: "Setting up", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "crit" };
    case "releasing":
      return { label: "Deleting", tone: "neutral" };
    case "off":
      return { label: "Off", tone: "neutral" };
  }
}

/** `340 of 1,204 notes`, or a dash before the first pass has reported. */
export function meaningProgressLine(row: Pick<MeaningIndexRow, "notesIndexed" | "notesPending">): string {
  if (row.notesIndexed === null) return "—";
  const format = (n: number) => n.toLocaleString("en-US");
  if (row.notesPending === null) return `${format(row.notesIndexed)} notes`;
  return `${format(row.notesIndexed)} of ${format(row.notesIndexed + row.notesPending)} notes`;
}

const CODE_WORDS: Record<string, string> = {
  NOT_CONFIGURED: "No Cloudflare credential set",
  UNAUTHORIZED: "Cloudflare refused the token",
  NOT_FOUND: "The index is missing",
  RATE_LIMITED: "Cloudflare rate limited us",
  UNAVAILABLE: "Cloudflare could not be reached",
  REFUSED: "Cloudflare refused a request",
  STORE_FAILED: "Could not save progress to the bucket",
};

/** What went wrong, in words, with our cause beside it: `Cloudflare refused a request (http_400)`. */
export function meaningFailureLine(row: Pick<MeaningIndexRow, "errorCode" | "errorCause">): string | null {
  if (row.errorCode === null) return null;
  const words = CODE_WORDS[row.errorCode] ?? row.errorCode;
  return row.errorCause === null ? words : `${words} (${row.errorCause})`;
}

/** Restart is offered for every row an owner has not turned off and that is not on its way out. */
export function canRestartMeaning(row: Pick<MeaningIndexRow, "status" | "enabled">): boolean {
  return row.enabled && row.status !== "releasing" && row.status !== "off";
}

/** The rows that "Restart everything stuck" would touch. */
export function stuckMeaningCount(rows: readonly Pick<MeaningIndexRow, "status" | "enabled">[]): number {
  return rows.filter(
    (row) => row.enabled && (row.status === "failed" || row.status === "provisioning" || row.status === "backfilling"),
  ).length;
}

/** The line after a restart, said in the panel. */
export function restartedLine(restarted: number, outcome?: string): string {
  if (outcome === "turnedOff") return "Not restarted: the owner turned search by meaning off.";
  if (outcome === "busy") return "Not restarted: it is already setting up or being deleted.";
  if (outcome === "noWorkspace") return "Not restarted: that workspace no longer exists.";
  if (restarted === 0) return "Nothing needed restarting.";
  return restarted === 1 ? "Restarted. It picks up where it stopped." : `Restarted ${restarted} workspaces.`;
}
