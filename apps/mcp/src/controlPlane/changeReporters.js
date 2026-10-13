/**
 * The reporters a write's `recordChange` reaches for, bound to one workspace.
 * Split out of `http/route.js` so the queue consumer (`moves/queueConsumer.js`)
 * binds the same ones: a move finished by a queued job is a write like any
 * other, and the Convex tree hears of it only through `reportTreeTouch`.
 */

/**
 * The two reporters every write's `recordChange` reaches for, bound to the
 * workspace `store` reaches — the connection's own for the session store, the
 * addressed one for a store `openContext` built. Bound per store rather than
 * per connection because a cross-context write lights the dot on, and re-lists
 * the tree of, the context it was written into; a store with neither is a
 * write nobody watching that context hears about until the next walk.
 *
 * `reportTreeChange` is called inside work that is already deferred (see
 * `announceTreeChange`); `reportActivity` defers its own send, and is dropped
 * on a host that cannot keep it alive — the line is in the customer's bucket
 * either way.
 */
export function attachChangeReporters(store, workspaceId, controlPlane) {
  store.reportTreeChange = (audiences) =>
    controlPlane.reportTreeChange(workspaceId, audiences).catch(() => {});
  store.reportTreeTouch = (touch) =>
    controlPlane.reportTreeTouch(workspaceId, touch).catch(() => {});
  store.reportWebsiteChange = (paths) =>
    controlPlane.reportWebsiteChange(workspaceId, paths).catch(() => {});
  store.reportRoutineChange = (paths, userId) =>
    controlPlane.reportRoutineChange(workspaceId, userId, paths).catch(() => {});
  // A note leaving this context for another: the console map's record of it.
  // Deferred and swallowed like `reportActivity`; the move itself has landed.
  store.reportContextMove = (move) => {
    const send = controlPlane.reportContextMove(workspaceId, move).catch(() => {});
    if (typeof store.defer !== "function") return;
    try {
      store.defer(send);
    } catch {
      // A host whose `waitUntil` refuses the work simply does not report.
    }
  };
  // How long a search took and which index answered (`search/visibleNotes.js`),
  // for the admin console's search timing log. Behind the answer, like the rest.
  store.reportSearchTiming = (timing) => {
    // Checked before the request is built: `reportUsage`'s rule, a fetch
    // nothing keeps alive is a subrequest spent on nothing.
    if (typeof store.defer !== "function") return;
    try {
      store.defer(controlPlane.reportSearchTiming({ ...timing, workspaceId }).catch(() => {}));
    } catch {
      // A host whose `waitUntil` refuses the work simply does not report.
    }
  };
  store.reportActivity = (teamVisible) => {
    const send = controlPlane.reportActivity(workspaceId, teamVisible === true).catch(() => {});
    if (typeof store.defer !== "function") return;
    try {
      store.defer(send);
    } catch {
      // A host whose `waitUntil` refuses the work simply does not report.
    }
  };
}
