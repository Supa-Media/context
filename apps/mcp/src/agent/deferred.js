/**
 * Work that is ours rather than the person's runs after the answer has gone,
 * where the host lets it, rather than before.
 */
export async function deferred(store, work) {
  try {
    if (typeof store.defer !== "function") throw new Error("no defer");
    store.defer(work);
  } catch {
    await work;
  }
}

/**
 * A read started now and awaited later, so the reads a turn needs overlap
 * instead of queueing one behind another. Awaiting it later still throws what
 * it threw; a turn that returns before awaiting it does not leave an unhandled
 * rejection behind.
 */
export function ahead(work) {
  const read = Promise.resolve(work);
  read.catch(() => {});
  return read;
}

/**
 * A turn's own after-work (`afterAnswer` in `route.js`), started only once its
 * response is ready. Started earlier, behind the answer but still inside the
 * request, it took the Worker's six connections and the reply's own last
 * reads queued behind it: 10 s of a "hi Tex" after its answer (2026-10-31).
 * Each is still best effort: one that fails costs us a row, never the answer.
 */
export async function afterTurn(store, later) {
  for (const work of later.splice(0)) await deferred(store, Promise.resolve().then(work).catch(() => {}));
}
