/**
 * Path arithmetic for keyed moves still moving (`rowMoves`,
 * `rowMoveChunks.ts`): where a row's path is drawn while a move that reaches
 * it is in flight. A pending move is a pair of paths, `from` and `to`, as
 * they were named when the move was made. Chained moves (`a` to `b`, then
 * `b/x` to `c`) fold into one answer.
 */

import type { PendingMove } from "./moveOverlay";

/** `key` renamed by one move, or `null` when the move does not reach it. */
function renamed(key: string, from: string, to: string): string | null {
  if (key === from) return to;
  if (key.startsWith(`${from}/`)) return `${to}${key.slice(from.length)}`;
  return null;
}

/**
 * Where a row's path is in the tree people see: folded through every pending
 * move, oldest first. A folder marker key (`a/`) maps like the folder.
 */
export function logicalPath(key: string, moves: readonly PendingMove[]): string {
  let path = key;
  for (const move of moves) path = renamed(path, move.from, move.to) ?? path;
  return path;
}

/**
 * Every row path that may hold what the tree draws at `logical`, newest move
 * last undone first: the logical path itself, then each old name a pending
 * move is carrying away from. Only paths that really fold to `logical` are
 * returned.
 */
export function physicalCandidates(logical: string, moves: readonly PendingMove[]): string[] {
  const found = [logical];
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const move = moves[index];
    for (const path of [...found]) {
      const before = renamed(path, move.to, move.from);
      if (before !== null && !found.includes(before)) found.push(before);
    }
  }
  return found.filter((path) => logicalPath(path, moves) === logical);
}
