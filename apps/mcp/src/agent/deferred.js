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
