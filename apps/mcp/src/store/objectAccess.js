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

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

/**
 * People added to one row's list by name or address (`addRowPeople`, `set_visibility`'s `people`), written in the
 * workspace object first: `ws.write.access` with `mode: "add"`, emails as grantees and handles resolved from the
 * object's own cache of names (`workspaceStore/handleCache.js`). A handle it has not been told yet comes back as
 * `RESOLVE`; this asks the control plane once (`resolveHandles`, read only) and sends the answer with the write.
 * A handle nobody holds is `GRANTEE_NOT_FOUND` with nothing written, as the control plane answers it.
 *
 * Owner only, as the control plane's list is (anyone else goes to it and is refused there). The control plane's
 * `addGrantees` is the answer whenever the object cannot decide alone, and for an entry this does not read as a plain
 * name or address.
 */
export function objectFirstAddGrantees(controlAddGrantees, controlResolveHandles, { client = null, home = null, role, userId = null, clientId = null, canWrite, workspaceId, log = () => {} }) {
  if (!client || typeof client.write?.access !== "function" || home !== HOMES.OBJECT || typeof controlResolveHandles !== "function") {
    return controlAddGrantees;
  }
  return async (change) => {
    const entries = Array.isArray(change.entries) ? change.entries : [];
    if (!canWrite || role !== "owner" || entries.length === 0) return await controlAddGrantees(change);
    const grantees = [];
    const handles = [];
    for (const entry of entries) {
      const handle = typeof entry?.handle === "string" ? entry.handle : null;
      const email = typeof entry?.email === "string" ? entry.email.trim() : null;
      if ((handle === null) === (email === null) || (entry.role !== "view" && entry.role !== "edit")) return await controlAddGrantees(change);
      if (email !== null) {
        if (!EMAIL.test(email)) return await controlAddGrantees(change);
        grantees.push({ kind: "email", id: email.toLowerCase(), role: entry.role });
      } else {
        handles.push({ handle, role: entry.role });
      }
    }
    const actor = { role, ...(userId ? { userId } : {}), ...(clientId ? { clientId } : {}) };
    const ask = (resolved) =>
      client.write.access({
        path: change.path,
        mode: "add",
        ...(grantees.length > 0 ? { grantees } : {}),
        ...(handles.length > 0 ? { handles } : {}),
        ...(resolved ? { resolved } : {}),
        actor,
      });
    try {
      let answer = await ask(null);
      if (answer?.ok === false && answer.code === "RESOLVE" && Array.isArray(answer.handles)) {
        const asked = await controlResolveHandles(answer.handles);
        if (asked?.ok !== true || !Array.isArray(asked.resolved)) return await controlAddGrantees(change);
        if (asked.resolved.some((entry) => entry.grantee === null)) return { ok: false, code: "GRANTEE_NOT_FOUND" };
        answer = await ask(asked.resolved.map((entry) => ({ handle: entry.handle, kind: entry.grantee.kind, id: entry.grantee.id })));
      }
      if (answer?.ok === true && Number.isFinite(answer.version)) return { ok: true, version: answer.version };
      if (answer?.code === "MIRROR_PENDING") return { ok: false, code: "MIRROR_PENDING" };
      if (answer?.ok === false && (answer.code === "FORBIDDEN" || answer.code === "INVALID")) return { ok: false, code: answer.code };
      log("workspace_object_people_passed", { workspaceId, code: answer?.code ?? null });
    } catch (error) {
      // The error's class only: a message can quote a path or a name.
      log("workspace_object_people_failed", { workspaceId, error: error?.name ?? "Error" });
    }
    return await controlAddGrantees(change);
  };
}
