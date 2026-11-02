/**
 * The gateway's client for a person object's calls (`workspaceStore/access.js`): `workspaceClient(env,
 * personalWorkspaceId).access`. `ask(op, fields)` is the workspace client's own call, which adds nothing but the body;
 * every call here names the personal workspace, so the object refuses one meant for somebody else.
 */

import { ACCESS_OPS } from "./access.js";

const TABLES = { reach: "reach", sharedToMe: "shared", connections: "connections" };

export function personAccessClient(ask, personalWorkspaceId) {
  const call = async (op, fields = {}) => await ask(op, { ...fields, personalWorkspaceId });
  const table = (name) => ({
    put: async (rows) => await call(`person.${name}.put`, { rows }),
    remove: async (keys, at) => await call(`person.${name}.remove`, { keys, at }),
    list: async ({ after = null, limit = 1000 } = {}) => await call(`person.${name}.list`, { after, limit }),
    snapshot: async ({ epoch, rows, last = false, mode = "replace" }) => await call(`person.${name}.snapshot`, { epoch, rows, last, mode }),
    digest: async () => await call(`person.${name}.digest`),
  });
  const access = Object.fromEntries(Object.entries(TABLES).map(([key, name]) => [key, table(name)]));
  access.connections.revoke = async (grantId, at) => await call(ACCESS_OPS.CONNECTIONS_REVOKE, { grantId, at });
  access.connections.rotate = async ({ refreshHash, clientId, next, at }) => (await call(ACCESS_OPS.CONNECTIONS_ROTATE, { refreshHash, clientId, next, at })).connection ?? null;
  access.connections.revokeToken = async ({ tokenHash, clientId, at }) => await call(ACCESS_OPS.CONNECTIONS_REVOKE_TOKEN, { tokenHash, clientId, at });
  access.session = async (tokenHash) => (await call(ACCESS_OPS.SESSION, { tokenHash })).session ?? null;
  access.touch = async (tokenHash, at = Date.now()) => await call(ACCESS_OPS.TOUCH, { tokenHash, at });
  access.pin = async (userId) => await call(ACCESS_OPS.PERSON_PIN, { userId });
  access.setHome = async (home) => (await call(ACCESS_OPS.PERSON_HOME, { home })).home;
  access.state = async () => await call(ACCESS_OPS.PERSON_STATE);
  return access;
}

/**
 * One access step, timed (Dev2, 2026-11-01: every step a timed, logged function): a point in `TEX_ENTRY` with blobs
 * `gateway`, `access`, the step and its state, its milliseconds, indexed by the person object. Names and times only.
 */
export async function timedAccessStep(env, step, who, run) {
  const at = Date.now();
  let state = "ok";
  try {
    return await run();
  } catch (error) {
    state = "failed";
    throw error;
  } finally {
    const dataset = env?.TEX_ENTRY;
    if (dataset && typeof dataset.writeDataPoint === "function") {
      try {
        dataset.writeDataPoint({ blobs: ["gateway", "access", step, state], doubles: [Date.now() - at, 0], indexes: [String(who).slice(0, 96)] });
      } catch {
        // Diagnostics never fail a request.
      }
    }
  }
}
