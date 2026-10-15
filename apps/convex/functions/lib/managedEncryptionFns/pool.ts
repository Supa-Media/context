/**
 * How many objects of one walk page are in flight at once. The pool lives in
 * the gateway (`apps/mcp/src/moves/pool.js`), shared with the mover that runs
 * walk pages next to the bucket; this module gives it its types here.
 */

import { settleInPool as settleInPoolJs } from "../../../../mcp/src/moves/pool.js";

export type PoolLimits<T> = {
  lanes: number;
  byteBudget: number;
  sizeOf: (item: T) => number;
};

export function settleInPool<T>(
  items: readonly T[],
  limits: PoolLimits<T>,
  work: (item: T) => Promise<void>,
): Promise<void> {
  return settleInPoolJs(items, limits, work);
}
