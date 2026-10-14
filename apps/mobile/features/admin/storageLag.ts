/**
 * Words for storage keeping up with the file tree: the time a folder move has
 * left at its measured pace, and the deployment's lag against the five-hour
 * promise (`apps/convex/functions/lib/nodes/moveLag.ts`). Pure, so tests read
 * the sentences staff will.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";

export type MovesLag = FunctionReturnType<typeof api.functions.nodeMovesAdmin.report>["lag"];

/** "1 minute", "40 minutes", "3 hours 10 minutes", "2 days". */
export function spanWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  const rest = minutes % 60;
  const head = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? head : `${head} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

/** " · about 40 minutes left", or nothing until a pass has measured a pace. */
export function timeLeftWords(etaMs: number | null): string {
  if (etaMs === null) return "";
  if (etaMs === 0) return " · finishing";
  return ` · about ${spanWords(etaMs)} left`;
}

const LATE_WORDS = { stuck: "stuck", old: "over 4 hours old", slow: "on pace to miss 5 hours" } as const;

/** Why a move is behind the promise, in a few words; null while it is on time. */
export function lateWords(late: keyof typeof LATE_WORDS | null): string | null {
  return late === null ? null : `Behind: ${LATE_WORDS[late]}`;
}

/** One line for the whole deployment, above the table. */
export function lagLine(lag: MovesLag): { text: string; tone: "ok" | "warn" | "crit" } {
  if (lag.oldestMs === null) return { text: "Every bucket matches its file tree.", tone: "ok" };
  const files = `${lag.remaining.toLocaleString("en-US")} ${lag.remaining === 1 ? "file" : "files"} still to copy`;
  const oldest = `oldest move ${spanWords(lag.oldestMs)} old`;
  const until = lag.catchUpMs === null ? "measuring the pace" : `caught up in about ${spanWords(lag.catchUpMs)}`;
  const parts = [files, oldest, until];
  if (lag.late > 0) parts.push(`${lag.late} ${lag.late === 1 ? "move" : "moves"} behind the ${spanWords(lag.targetMs)} promise`);
  return { text: `Storage: ${parts.join(" · ")}.`, tone: lag.late > 0 ? "crit" : "warn" };
}
