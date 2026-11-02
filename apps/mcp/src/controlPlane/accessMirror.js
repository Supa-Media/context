/**
 * Convex written behind an object's access write (`POST /gateway/access/mirror`;
 * `apps/convex/functions/accessMirror.ts`). A workspace object (or a person's)
 * calls this after it took a take-away write from the app's access socket, and
 * reports the change done only once this answered, so the control plane's own
 * checks and the copy switch's rollback never disagree with the object.
 * Ids and a role only; no token, no name.
 */

const MIRROR_TIMEOUT_MS = 5_000;

export function createAccessMirrorMethods({ post }) {
  return {
    /**
     * `change`: `{op: "remove_member"|"set_role"|"revoke_invite"|"revoke_connection", ..., at, by}`. Resolves
     * `{applied}`; throws when the control plane refused the change or could not be reached, so the object retries
     * with the same `at` and never reports it done.
     */
    async accessMirror(workspaceId, change) {
      return await post("/gateway/access/mirror", { workspaceId, change }, { timeoutMs: MIRROR_TIMEOUT_MS });
    },
  };
}
