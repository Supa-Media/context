/**
 * A `ctx` for `worker.fetch` whose `waitUntil` is real.
 *
 * Every call site here used to pass `{ waitUntil() {} }` — a stub that swallows
 * the promise — which was fine while nothing in the worker deferred anything
 * that a test could observe. `searchVisibleNotes` now finishes the search index
 * after the response has gone out, and that work spends **the same subrequest
 * counter** the answer did, so a swallowing stub makes two different mistakes at
 * once: op counts taken after a search include however much of the deferred pass
 * happened to have run by then, and a test asserting that one request converged
 * an index would be asserting it against work it dropped on the floor.
 *
 * So `waitUntil` collects, and `settle()` waits. That is also the honest model
 * of a Worker invocation: the runtime keeps the invocation alive until the
 * promises given to `waitUntil` resolve, and the subrequest ceiling covers all
 * of it. A test that measures after `settle()` is measuring one whole
 * invocation.
 *
 * `settle` never rejects. Deferred work that fails is a logged exception on an
 * invocation whose response has already been sent — never a failed request —
 * and a helper that turned it into a rejected assertion would be inventing a
 * failure mode the runtime does not have.
 */
export function createWorkerCtx() {
  const pending = [];
  return {
    ctx: {
      waitUntil(work) {
        pending.push(Promise.resolve(work));
      },
    },
    /** Wait for everything deferred so far, including anything it defers. */
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}
