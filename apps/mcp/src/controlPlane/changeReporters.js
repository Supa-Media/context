/**
 * The reporters a write's `recordChange` reaches for, bound to one workspace.
 * Split out of `http/route.js` so every store a request opens binds the same
 * ones: a move is a write like any other, and the Convex tree hears of it only
 * through `reportTreeTouch`.
 */

import { syncRoutineAlarms } from "../texStore/routineAlarm.js";
import { actorSeedOf, searchActorHash, searchHitHash, searchQualityKeyOf, searchTimingFields } from "../search/quality.js";

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
export function attachChangeReporters(store, workspaceId, controlPlane, { readLedger, env, searchEnv, searchKey } = {}) {
  // The search quality key (`search/quality.js`): from the Worker's env (`searchEnv` for a store `openContext`
  // built, which is given no `env`) unless a test hands one in. Asked for only when a search or an open is reported, so a request that
  // searches nothing never reaches the key's object.
  const qualityKey = () => searchKey ?? searchQualityKeyOf(searchEnv ?? env);
  attachSmallData(store, workspaceId, controlPlane, readLedger);
  store.reportTreeChange = (audiences) =>
    controlPlane.reportTreeChange(workspaceId, audiences).catch(() => {});
  store.reportTreeTouch = (touch) =>
    controlPlane.reportTreeTouch(workspaceId, touch).catch(() => {});
  store.reportWebsiteChange = (paths) =>
    controlPlane.reportWebsiteChange(workspaceId, paths).catch(() => {});
  store.reportRoutineChange = (paths, userId) =>
    controlPlane.reportRoutineChange(workspaceId, userId, paths).catch(() => {});
  // A person's own Tex routines run on their Tex store's alarm, set from the file (`texStore/routineAlarm.js`).
  // Given the Worker's env only where the session's own workspace is the one written (never a cross-context store).
  if (env !== undefined) store.syncRoutineAlarms = (paths) => syncRoutineAlarms(env, workspaceId, store, paths);
  // How long a search took and which index answered (`search/visibleNotes.js`), and on the counted row its
  // quality (`search/quality.js`), for the admin console's search log. Behind the answer, like the rest. The
  // hashes are taken here, inside the deferred work, so a host that cannot defer computes and sends nothing.
  store.reportSearchTiming = (timing) => {
    // Checked before the request is built: `reportUsage`'s rule, a fetch
    // nothing keeps alive is a subrequest spent on nothing.
    if (typeof store.defer !== "function") return;
    try {
      store.defer(
        qualityKey()
          .then((key) => searchTimingFields(workspaceId, timing, key))
          .then((fields) => controlPlane.reportSearchTiming(fields))
          .catch(() => {}),
      );
    } catch {
      // A host whose `waitUntil` refuses the work simply does not report.
    }
  };
  // A search hit's note was opened (`search/quality.js` `reportOpenedNote`): the searcher's actor, and the hit's
  // MAC of the address the note was read by. Behind the read, like the timing above. No key, no report.
  store.reportSearchOpen = (address) => {
    const seed = actorSeedOf(store.actor);
    if (typeof store.defer !== "function" || !seed) return;
    try {
      store.defer(
        qualityKey()
          .then((key) =>
            key === null
              ? null
              : Promise.all([searchActorHash(key, seed), searchHitHash(key, address)])
                  .then(([actor, hit]) => controlPlane.reportSearchOpen({ workspaceId, actor, hit })),
          )
          .catch(() => {}),
      );
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

/**
 * The forwarding ledger and the folder icons, held by the control plane
 * (`apps/convex/functions/lib/schema/smallData.ts`), as the shared engines'
 * hooks (`forwarding.js`, `folderIcons.cjs`) read them. With these on a store
 * nothing reads `.context/forwarding.json` or `.context/folder-icons.json`
 * back; the control plane writes both from its rows.
 *
 * - Reading the ledger asks `/gateway/tree/facts`: with `readLedger` where
 *   the caller names how (a gateway job's ticket;
 *   the console's token, `live/presenceRoute.js`), else with this request's
 *   own token (`store.treeFacts`, `http/routing.js`), and gets it only as far
 *   as that proof may see. A store with neither reads no ledger at all: an
 *   empty one, never the bucket's.
 * - Recording a move, or carrying its icons, goes to the rows first, awaited.
 */
export function attachSmallData(store, workspaceId, controlPlane, readLedger) {
  if (typeof controlPlane?.recordMoved !== "function") return;
  const ask =
    typeof readLedger === "function"
      ? readLedger
      : () => (typeof store.treeFacts === "function" ? store.treeFacts({ ask: "forwarding" }) : null);
  Object.defineProperty(store, "forwardingLedger", {
    value: {
      read: async () => {
        const answer = await ask();
        return answer?.served === true && Array.isArray(answer.forwarding) ? answer.forwarding : [];
      },
      record: (moves) => controlPlane.recordMoved(workspaceId, { forwarding: moves }),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(store, "folderIconsHeld", {
    value: {
      remap: (moves) => controlPlane.recordMoved(workspaceId, { icons: moves }),
      // No gateway tool deletes for good; a store asked to anyway changes nothing.
      drop: async () => null,
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
}
