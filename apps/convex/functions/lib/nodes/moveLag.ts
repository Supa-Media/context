/**
 * How far the bucket is behind the file tree, and how long it will take to
 * catch up (project file `move-engine/plan.md`, step C).
 *
 * The promise is that storage matches the tree within five hours of a move.
 * A move is late, and staff are told, when it is already four hours old, when
 * its measured pace says it will not finish inside the five, or when it is
 * stuck. Counts and times only: nothing here sees a path.
 */

import { STUCK_ATTEMPTS } from "./moveRules";

/** The promise: a move is in the bucket within this long of being made. */
export const CATCH_UP_TARGET_MS = 5 * 60 * 60_000;
/** Past this age a move is late whatever its pace: an hour's warning before the promise breaks. */
export const LATE_AFTER_MS = 4 * 60 * 60_000;
/** Weight of the newest pass in the smoothed pace. */
const RATE_WEIGHT = 0.3;

export type LateReason = "stuck" | "old" | "slow";

export interface LagRow {
  state: "preparing" | "moving";
  total: number;
  moved: number;
  attempts: number;
  createdAt: number;
  rate?: number;
}

/**
 * The pace after one pass that moved `moved` objects in `ms`, blended into the
 * pace so far. A pass that moved nothing still counts: it is the pace a
 * person waits at.
 */
export function blendRate(previous: number | undefined, moved: number, ms: number): number | undefined {
  if (!(ms > 0) || !Number.isFinite(moved) || moved < 0) return previous;
  const sample = (moved * 1000) / ms;
  return previous === undefined ? sample : previous * (1 - RATE_WEIGHT) + sample * RATE_WEIGHT;
}

export function remainingOf(row: Pick<LagRow, "total" | "moved">): number {
  return Math.max(0, row.total - row.moved);
}

/** Time left at the measured pace; `null` until a pass has measured one, or while it is zero. */
export function etaMs(row: Pick<LagRow, "total" | "moved" | "rate">): number | null {
  const remaining = remainingOf(row);
  if (remaining === 0) return 0;
  if (row.rate === undefined || !(row.rate > 0)) return null;
  return Math.ceil((remaining / row.rate) * 1000);
}

/** Why a move is late, or `null` while it is on time. */
export function lateReason(row: LagRow, now: number): LateReason | null {
  if (row.state !== "moving") return null;
  if (row.attempts >= STUCK_ATTEMPTS) return "stuck";
  const age = Math.max(0, now - row.createdAt);
  if (age >= LATE_AFTER_MS) return "old";
  const eta = etaMs(row);
  if (eta !== null && age + eta > CATCH_UP_TARGET_MS) return "slow";
  return null;
}

/**
 * One workspace's moves run one after another, so the time until its bucket
 * matches is the sum of theirs; `null` when any of them has no pace yet.
 */
export function workspaceEtaMs(rows: readonly Pick<LagRow, "total" | "moved" | "rate">[]): number | null {
  let sum = 0;
  for (const row of rows) {
    const eta = etaMs(row);
    if (eta === null) return null;
    sum += eta;
  }
  return sum;
}
