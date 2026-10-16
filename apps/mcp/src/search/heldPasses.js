/**
 * Index passes held until the work a person is waiting on is over.
 *
 * A search starts its index pass behind the response (`maintenance.js`,
 * `store.defer`), and for one MCP tool call that is behind the only thing
 * anyone waits for. An assistant's turn is different: every search, read and
 * model call of the turn runs in one invocation, and a Worker invocation has
 * six connections. One texted search across four workspaces started four
 * passes of up to `SEARCH_SUBREQUEST_BUDGET` calls each, and the rest of the
 * turn queued behind them: on production, 2026-10-16, one Tex turn issued about
 * 2,000 subrequests whose median wait was a second, and a search that answers
 * in under one took over ten.
 *
 * So a turn (and a search across workspaces, while its other workspaces are
 * still answering) holds its passes: each workspace's first pass is kept, the
 * rest are dropped as the same work again, and all of them start when the
 * holder is released, still behind the response. Nothing is skipped: a pass
 * runs later in the same invocation, never not at all.
 */

/** Where a held pass is kept, one per workspace. */
function keyOf(store) {
  return store?.actor?.workspaceId ?? store;
}

/**
 * Start holding `store`'s index passes, and those of every context opened
 * from it while the hold lasts (`openContext` copies `holdSearchPass`).
 *
 * Holds nothing on a host that cannot defer: there a pass runs inline and
 * capped (`maintenance.js`), and holding it would mean never running it. An
 * outer hold already in place is left as it is, so a search across
 * workspaces inside a turn is released with the turn.
 *
 * @returns {{ release: () => number }} `release` starts every held pass
 *   behind the response and says how many it started
 */
export function holdSearchPasses(store) {
  if (typeof store?.defer !== "function" || typeof store.holdSearchPass === "function") {
    return { release: () => 0 };
  }
  const held = new Map();
  let holding = true;
  const hold = (owner, start) => {
    // A context opened during the hold keeps this function after it ends:
    // past the release, its passes start as they always did.
    if (!holding) {
      store.defer(start());
      return;
    }
    const key = keyOf(owner);
    if (!held.has(key)) held.set(key, start);
  };
  store.holdSearchPass = hold;
  return {
    release() {
      holding = false;
      if (store.holdSearchPass === hold) delete store.holdSearchPass;
      const starts = [...held.values()];
      held.clear();
      for (const start of starts) {
        try {
          store.defer(start());
        } catch {
          // A pass that cannot be started is the next search's to start.
        }
      }
      return starts.length;
    },
  };
}

/**
 * Hand a pass to the hold in place, or start it behind the response.
 * Throws where `store.defer` does, so the caller's inline fallback stands.
 *
 * @param {object} store
 * @param {() => Promise<unknown>} start the pass, not yet started
 */
export function deferSearchPass(store, start) {
  if (typeof store.holdSearchPass === "function") {
    store.holdSearchPass(store, start);
    return;
  }
  store.defer(start());
}

/**
 * Run `work` (an assistant's turn) with `store`'s index passes held until it
 * settles, answered or failed.
 *
 * @template T
 * @param {object} store
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withSearchPassesHeld(store, work) {
  const passes = holdSearchPasses(store);
  try {
    return await work();
  } finally {
    passes.release();
  }
}
