/**
 * How many objects of one walk page are in flight at once.
 *
 * `lanes` objects move together, and each lane takes the next object the
 * moment it is free, so one slow object never holds the rest of a batch
 * back. The walk holds each object's bytes in memory two or three times
 * (read, sealed, read back), so a byte budget caps what is in flight as
 * well; an object bigger than the whole budget still runs, on its own.
 *
 * The failure rule is the one the walk has always had: once one object
 * fails, nothing new starts, and the failure is reported only after every
 * object already started has settled. Reporting early would mark the
 * workspace failed while its siblings were still writing.
 */

export type PoolLimits<T> = {
  lanes: number;
  byteBudget: number;
  sizeOf: (item: T) => number;
};

export async function settleInPool<T>(
  items: readonly T[],
  limits: PoolLimits<T>,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let inFlight = 0;
  let bytes = 0;
  let failure: { reason: unknown } | null = null;

  await new Promise<void>((resolve) => {
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
          (reason: unknown) => {
            failure ??= { reason };
            settle(size);
          },
        );
      }
      if (inFlight === 0) resolve();
    };
    const settle = (size: number) => {
      inFlight -= 1;
      bytes -= size;
      pump();
    };
    pump();
  });

  if (failure !== null) throw (failure as { reason: unknown }).reason;
}
