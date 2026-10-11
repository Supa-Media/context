/**
 * Recording a search's time from an action (`functions/searchTimings.ts`).
 *
 * A timing must never be how a search fails: the row is written after the
 * answer exists, and any failure to write it is swallowed here, once, rather
 * than at each call site.
 */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";

/** Longer than any search is allowed to run; anything past it is a broken clock. */
export const MAX_SEARCH_MS = 120_000;

export type SearchSurface = "app" | "page" | "ai";
export type SearchAnsweredBy = "fast" | "index" | "scan" | "none" | "failed";

export function clampSearchMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_SEARCH_MS, Math.max(0, Math.round(ms)));
}

/** What a settled console search says about itself, for its row. */
export function timingOf(
  answer: { hits: unknown[]; answeredBy?: "fast" | "index" | "none" } | null,
): { answeredBy: SearchAnsweredBy; found: boolean } {
  if (answer === null) return { answeredBy: "failed", found: false };
  return { answeredBy: answer.answeredBy ?? "none", found: answer.hits.length > 0 };
}

export async function recordSearchTiming(
  ctx: ActionCtx,
  row: {
    workspaceId: Id<"workspaces">;
    surface: SearchSurface;
    answeredBy: SearchAnsweredBy;
    found: boolean;
    ms: number;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.functions.searchTimings.record, { ...row, ms: clampSearchMs(row.ms) });
  } catch {
    // A search that worked and was not timed is a good outcome; a search that
    // failed because its timing could not be written is not.
  }
}
