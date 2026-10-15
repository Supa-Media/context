/**
 * The small fixed rules of the move queue (`functions/nodeMoves.ts`): how long
 * a pass holds a move, how a failed pass backs off, when staff see a move as
 * stuck, and which two moves may not be prepared at once.
 */

/** A pass holds its move this long; a pass that died is taken over after it. */
export const MOVE_LEASE_MS = 5 * 60_000;

/** Failed passes in a row before the admin page calls a move stuck and offers Retry and Undo. */
export const STUCK_ATTEMPTS = 3;

/** The wait before the next pass after `attempts` failures in a row: 30 s doubling, at most 15 min. */
export function moveRetryDelay(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(30_000 * 2 ** Math.min(n - 1, 10), 15 * 60_000);
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Whether two moves touch a shared name: either end of one at, inside or above either end of the other. */
export function movesOverlap(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  for (const x of [a.from, a.to]) {
    for (const y of [b.from, b.to]) {
      if (within(x, y) || within(y, x)) return true;
    }
  }
  return false;
}
