/**
 * A row's tier written in the workspace object first (`ws.write.access`, `workspaceStore/accessWrite.js`), for a
 * workspace whose notes live there (home `object`): no control-plane round trip for a tier-only change
 * (`docs/decisions/storage-and-credentials/object-row-writes.md`).
 *
 * `controlSetAccess` is the control plane's `setAccess` (`controlPlane/privacy.js`). It is the answer whenever the
 * object cannot decide alone (`NOT_READY`, `NO_ROW`), is unreachable, or answers something this does not know, and
 * it is called with the same change as before. A grantee list is always the control plane's: resolving a handle
 * and adding people stay there.
 *
 * Answers, as `setRowTier` (`store/privacyAuthority.js`) reads them:
 * - `{ok: true, version}`: the object's version, which the request holds from here on.
 * - `CONFLICT`, `FORBIDDEN`, `NOT_FOUND`, `INVALID`: the object's refusal, passed through with its code. `CONFLICT`
 *   is retried without the version by `setRowTier`, as it is for the control plane.
 * - `MIRROR_PENDING` (503): a narrowing change is committed in the object, but Convex has not taken it yet. The body
 *   carries no version, so it is not answered as `ok`: it is `{ok: false, code: "MIRROR_PENDING"}` and the caller
 *   retries. A retry of a change already made is answered `ok` at once (the object finds the tier as asked).
 *
 * `canWrite` is the control plane's own check, made here before the object is asked: an owner or editor holding
 * `context:write`. Anyone else goes straight to the control plane, which refuses as it always has.
 */

import { HOMES } from "../workspaceStore/api.js";

/** The object's refusals the control plane gives too, passed through unchanged. */
const REFUSED = new Set(["CONFLICT", "FORBIDDEN", "NOT_FOUND", "INVALID", "PENDING_FULL"]);

/**
 * @param {(change: object) => Promise<object>} controlSetAccess
 * @param {{client: object|null, home?: string|null, role: string, userId?: string|null, clientId?: string|null, canWrite: boolean, workspaceId: string, log?: (event: string, fields: object) => void}} options
 */
export function objectFirstSetAccess(controlSetAccess, { client = null, home = null, role, userId = null, clientId = null, canWrite, workspaceId, log = () => {} }) {
  if (!client || typeof client.write?.access !== "function" || home !== HOMES.OBJECT) return controlSetAccess;
  return async (change) => {
    if (!canWrite || Array.isArray(change.grantees)) return await controlSetAccess(change);
    const actor = { role, ...(userId ? { userId } : {}), ...(clientId ? { clientId } : {}) };
    let answer;
    try {
      answer = await client.write.access({
        path: change.path,
        ...(change.base !== undefined ? { base: change.base } : {}),
        ...(change.kind !== undefined ? { kind: change.kind } : {}),
        ...(typeof change.expectedVersion === "number" ? { expectedVersion: change.expectedVersion } : {}),
        actor,
      });
    } catch (error) {
      // The error's class only: a message can quote a path, and logs never carry note names.
      log("workspace_object_access_failed", { workspaceId, error: error?.name ?? "Error" });
      return await controlSetAccess(change);
    }
    if (answer?.ok === true && Number.isFinite(answer.version)) return { ok: true, version: answer.version };
    if (answer?.code === "MIRROR_PENDING") return { ok: false, code: "MIRROR_PENDING" };
    if (answer?.ok === false && REFUSED.has(answer.code)) {
      return { ok: false, code: answer.code, ...(Number.isFinite(answer.version) ? { version: answer.version } : {}) };
    }
    // NOT_READY, NO_ROW, or anything the object did not decide: the control plane, as before.
    log("workspace_object_access_passed", { workspaceId, code: answer?.code ?? null });
    return await controlSetAccess(change);
  };
}
