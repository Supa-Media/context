/**
 * Convex written behind a workspace object's row changes (`POST /gateway/rows/mirror`). The object queues each change
 * it took (`workspaceStore/mirrorOutbox.js`) and sends them here in order (`workspaceStore/mirrorFlush.js`). Convex
 * applies them without opening an outbox entry of its own, so a change never bounces back. Ids and fields only;
 * no token, no note text.
 */

const MIRROR_TIMEOUT_MS = 10_000;

export function createRowsMirrorMethods({ post }) {
  return {
    /** `changes`: `[{seq, op: "wrote", record, objectAt}]`. Resolves `{applied: seq[], skipped: [{seq, reason}]}`; throws when unreachable. */
    async rowsMirror(workspaceId, changes) {
      return await post("/gateway/rows/mirror", { workspaceId, changes }, { timeoutMs: MIRROR_TIMEOUT_MS });
    },
  };
}
