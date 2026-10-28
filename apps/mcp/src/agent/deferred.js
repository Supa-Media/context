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
