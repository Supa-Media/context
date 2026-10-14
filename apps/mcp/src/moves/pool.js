/**
 * How many objects of one page are in flight at once.
 *
 * `lanes` objects move together, and each lane takes the next object the
 * moment it is free, so one slow object never holds the rest of a batch
 * back. A page holds each object's bytes in memory two or three times (read,
 * sealed, read back), so a byte budget caps what is in flight as well; an
 * object bigger than the whole budget still runs, on its own.
 *
 * The failure rule: once one object fails, nothing new starts, and the
 * failure is reported only after every object already started has settled.
 * Reporting early would mark the workspace failed while its siblings were
 * still writing.
 *
 * Shared by the encryption walk wherever it runs: the gateway's mover
 * (`moves/walkPage.js`) and the control plane's fallback
 * (`apps/convex/functions/lib/managedEncryptionFns/pool.ts` re-exports it).
 */

/**
 * @template T
 * @param {readonly T[]} items
 * @param {{ lanes: number, byteBudget: number, sizeOf: (item: T) => number }} limits
 * @param {(item: T) => Promise<void>} work
 * @returns {Promise<void>}
 */
export async function settleInPool(items, limits, work) {
  let next = 0;
  let inFlight = 0;
  let bytes = 0;
  /** @type {{ reason: unknown } | null} */
  let failure = null;

  await new Promise((resolve) => {
    const pump = () => {
      while (failure === null && next < items.length && inFlight < limits.lanes) {
        const item = items[next];
        const size = Math.max(0, limits.sizeOf(item) || 0);
        // Over budget waits for room, unless nothing is running: an object
        // larger than the budget must still get its turn, alone.
        if (inFlight > 0 && bytes + size > limits.byteBudget) break;
        next += 1;
        inFlight += 1;
        bytes += size;
        work(item).then(
          () => settle(size),
          (reason) => {
            failure ??= { reason };
            settle(size);
          },
        );
      }
      if (inFlight === 0) resolve(undefined);
    };
    const settle = (size) => {
      inFlight -= 1;
      bytes -= size;
      pump();
    };
    pump();
  });

  if (failure !== null) throw failure.reason;
}
