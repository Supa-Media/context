/**
 * An AI client's connection once its person's access lives in their object (decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`). The person object is the one authority for a connection;
 * the control plane keeps a copy written behind it, so rolling the switch back to `dual` loses nothing.
 *
 * - **Exchange.** The tokens name the person object (`cat1.<personalWorkspaceId>.…`, `workspaceStore/access.js`). The
 *   control plane makes the grant first, written behind (its id is the connection's, and it re-checks membership and
 *   clamps scopes as it always has), then the connection goes into the object. Only the object's copy resolves a
 *   session, so a grant the object never took is inert; it is still revoked, so the copy says what the object says.
 * - **Refresh.** The object rotates (its own reuse detection, client check and reach check), then the copy follows. A
 *   copy that fails to follow is logged and does not fail the refresh: the old refresh token is already spent, and
 *   refusing now would only end the person's session. The parity check names the drift.
 * - **Revoke.** The object first, then the copy, retried once: an old access token (`cat_…`) still resolves through
 *   the control plane until it expires, so its copy must say revoked too.
 *
 * An old refresh token (`crt_…`) is found through its index object (`workspaceStore/tokenIndex.js`); one whose person
 * is not switched, or whose index cannot be read, goes the old way, to the control plane.
 */

import { sha256Hex } from "../controlPlane.js";
import { ACCESS_HOMES, objectToken, parseToken } from "../workspaceStore/access.js";
import { workspaceClient } from "../workspaceStore/api.js";
import { timedAccessStep } from "../workspaceStore/personClient.js";
import { tokenIndexClient } from "../workspaceStore/tokenIndex.js";
import { randomToken } from "./responses.js";

/** The person object's access client, or `null` without the binding. Tests pass their own. */
const defaultObjects = (env, personalWorkspaceId) => workspaceClient(env, personalWorkspaceId)?.access ?? null;

/** A fresh pair naming `personalWorkspaceId`'s object. */
export function mintObjectPair(personalWorkspaceId) {
  return {
    accessToken: objectToken("access", personalWorkspaceId, randomToken(32)),
    refreshToken: objectToken("refresh", personalWorkspaceId, randomToken(32)),
  };
}

/** Whether the code's person is switched: the control plane names them on the spent code. */
export function exchangeHeldByObject(authorization) {
  const person = authorization?.person;
  return person !== null && typeof person === "object" && person.access === ACCESS_HOMES.OBJECT && typeof person.personalWorkspaceId === "string";
}

const failed = (answer) => answer === null || answer === undefined || typeof answer !== "object" || typeof answer.error === "string";

function logBehind(op, grantId) {
  // Ids and the step only, never a token or its hash.
  console.warn(JSON.stringify({ event: "access_copy_behind", op, grantId: typeof grantId === "string" ? grantId : null }));
}

async function mirror(controlPlane, personalWorkspaceId, change, tries = 1) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await controlPlane.accessMirror(personalWorkspaceId, change);
      return true;
    } catch {
      // Tried again below, then logged.
    }
  }
  logBehind(change.op, change.grantId);
  return false;
}

/**
 * The token exchange for a switched person. Answers the pair and the scopes, or `null` when the connection could not
 * be made (the caller answers `server_error`; the code is spent either way).
 */
export async function exchangeAtObject({ env, controlPlane, authorization, clientId, scopes, expiresAt, objects = defaultObjects }) {
  const personalWorkspaceId = authorization.person.personalWorkspaceId;
  const person = objects(env, personalWorkspaceId);
  if (person === null) return null;
  const { accessToken, refreshToken } = mintObjectPair(personalWorkspaceId);
  const { grantId, connection } = await controlPlane.createHeldGrant({
    workspaceId: authorization.workspaceId,
    userId: authorization.userId,
    clientId,
    scopes,
    hashedRefreshToken: await sha256Hex(refreshToken),
    hashedAccessToken: await sha256Hex(accessToken),
    accessTokenExpiresAt: expiresAt,
  });
  let kept = false;
  try {
    kept = !failed(await timedAccessStep(env, "person.connections.put", personalWorkspaceId, async () => await person.connections.put([connection])));
  } catch {
    kept = false;
  }
  if (!kept) {
    await mirror(controlPlane, personalWorkspaceId, { op: "revoke_connection", grantId, at: Date.now(), by: authorization.userId }, 2);
    return null;
  }
  return { accessToken, refreshToken, scopes: connection.scopes };
}

/**
 * Which person object answers for a presented refresh token: the one it names, or for an old token the one its index
 * names, if that person is switched. `null` means the control plane answers, as before the switch.
 */
export async function refreshHeldBy(env, presented, { objects = defaultObjects, index = tokenIndexClient } = {}) {
  const parsed = parseToken(presented);
  if (parsed === null || parsed.kind !== "refresh") return null;
  if (parsed.format === "object") return parsed.personalWorkspaceId;
  try {
    const personalWorkspaceId = await index(env, await sha256Hex(presented))?.get();
    if (typeof personalWorkspaceId !== "string") return null;
    const state = await objects(env, personalWorkspaceId)?.state();
    return state?.home === ACCESS_HOMES.OBJECT ? personalWorkspaceId : null;
  } catch {
    return null;
  }
}

/** A refresh at the object. Answers the new pair and its scopes, or `null` for `invalid_grant`. */
export async function refreshAtObject({ env, controlPlane, personalWorkspaceId, presented, clientId, scopes, expiresAt, objects = defaultObjects }) {
  const person = objects(env, personalWorkspaceId);
  if (person === null) return null;
  const { accessToken, refreshToken } = mintObjectPair(personalWorkspaceId);
  const at = Date.now();
  const next = { tokenHash: await sha256Hex(accessToken), refreshHash: await sha256Hex(refreshToken), expiresAt, ...(scopes ? { scopes } : {}) };
  let connection = null;
  try {
    connection = await timedAccessStep(env, "person.connections.rotate", personalWorkspaceId, async () => await person.connections.rotate({ refreshHash: await sha256Hex(presented), clientId, next, at }));
  } catch {
    return null;
  }
  if (connection === null || failed(connection) || typeof connection.grantId !== "string") return null;
  await mirror(controlPlane, personalWorkspaceId, {
    op: "rotate_connection",
    grantId: connection.grantId,
    tokenHash: next.tokenHash,
    refreshHash: next.refreshHash,
    expiresAt,
    scopes: connection.scopes,
    at,
  });
  return { accessToken, refreshToken, scopes: connection.scopes };
}

async function revokeIn(env, controlPlane, personalWorkspaceId, revoke) {
  const person = (revoke.objects ?? defaultObjects)(env, personalWorkspaceId);
  if (person === null) return false;
  const at = Date.now();
  const answer = await timedAccessStep(env, "person.connections.revoke", personalWorkspaceId, async () => await revoke.run(person, at));
  if (failed(answer) || answer.revoked !== true || typeof answer.grantId !== "string") return false;
  await mirror(controlPlane, personalWorkspaceId, { op: "revoke_connection", grantId: answer.grantId, at }, 2);
  return true;
}

/**
 * RFC 7009 for any token. A token that names its object, or an old refresh token whose switched person its index
 * names, is revoked there. Any other goes to the control plane; when that answers that the grant is held by an object
 * (an old access token of a switched person), the object revokes it by id. `true` when something was revoked.
 */
export async function revokeAnywhere({ env, controlPlane, token, hint, clientId, objects = defaultObjects, index = tokenIndexClient }) {
  const parsed = parseToken(token);
  if (parsed?.format === "object") {
    const tokenHash = await sha256Hex(token);
    return await revokeIn(env, controlPlane, parsed.personalWorkspaceId, { objects, run: async (person, at) => await person.connections.revokeToken({ tokenHash, clientId, at }) });
  }
  if (parsed?.kind === "refresh") {
    const held = await refreshHeldBy(env, token, { objects, index });
    if (held !== null) {
      const tokenHash = await sha256Hex(token);
      return await revokeIn(env, controlPlane, held, { objects, run: async (person, at) => await person.connections.revokeToken({ tokenHash, clientId, at }) });
    }
  }
  const tryType = async (type) => {
    const answer = await controlPlane.revokeGrantAnswer(token, type, clientId);
    if (answer.held) {
      const { grantId, personalWorkspaceId } = answer.held;
      return await revokeIn(env, controlPlane, personalWorkspaceId, {
        objects,
        run: async (person, at) => ({ ...(await person.connections.revoke(grantId, at)), grantId }),
      });
    }
    return answer.revoked === true;
  };
  if (await tryType(hint)) return true;
  return await tryType(hint === "access" ? "refresh" : "access");
}
