/**
 * The person object's answers (`workspaceStore/access.js` has the contract): the `person.*` calls, served by the
 * personal workspace's own object over `workspaceStore/personRows.js`. Each call names the personal workspace it is
 * meant for, and the object pins the first workspace it sees (`rows.pinWorkspace`), as every `ws.*` call does, so a
 * call meant for one person can never land in another's object.
 */

import { ACCESS_OPS, AccessRowRefused } from "./access.js";
import { sessionFor, withoutHashes } from "./personRows.js";

const TABLE_OF = { reach: "reach", shared: "shared", connections: "connections" };

/** `person.<table>.<verb>` for the five calls every table answers, else null. */
function tableCall(op) {
  const match = /^person\.(reach|shared|connections)\.(put|remove|list|snapshot|digest)$/.exec(op);
  return match === null ? null : { table: TABLE_OF[match[1]], verb: match[2] };
}

export const isPersonCall = (op) => typeof op === "string" && op.startsWith("person.");

/**
 * One `person.*` call. `store.person` is `personRows(sql)`; `store.rows` the workspace rows, whose pin names the
 * object's workspace. Answers JSON; a refused row is `422 refused`, as tree rows are.
 */
export async function servePersonCall(store, op, fields, now = Date.now()) {
  const person = store.person;
  try {
    store.rows.pinWorkspace(fields.personalWorkspaceId);
    const call = tableCall(op);
    if (call !== null) {
      switch (call.verb) {
        case "put": {
          const answer = person.put(call.table, fields.rows);
          if (call.table === "connections") await indexConnections(store, fields.rows, fields.personalWorkspaceId);
          return Response.json(answer);
        }
        case "remove":
          return Response.json(person.remove(call.table, fields.keys, fields.at));
        case "list":
          return Response.json(person.list(call.table, fields));
        case "snapshot": {
          const answer = person.snapshot(call.table, fields);
          if (call.table === "connections") await indexConnections(store, fields.rows, fields.personalWorkspaceId);
          return Response.json(answer);
        }
        case "digest":
          return Response.json(await person.digest(call.table));
      }
    }
    switch (op) {
      case ACCESS_OPS.SESSION:
        return Response.json({ session: sessionFor(person, fields.tokenHash, now) });
      case ACCESS_OPS.TOUCH:
        return Response.json(touch(person, fields, now));
      case ACCESS_OPS.CONNECTIONS_REVOKE:
        return Response.json(person.revoke(fields.grantId, fields.at));
      case ACCESS_OPS.CONNECTIONS_ROTATE:
        return Response.json(person.rotate(fields, now));
      case ACCESS_OPS.PERSON_PIN:
        return Response.json(person.pin(fields.userId));
      case ACCESS_OPS.PERSON_HOME:
        return Response.json({ home: person.setHome(fields.home) });
      case ACCESS_OPS.PERSON_STATE:
        return Response.json({ home: person.home(), person: person.person() });
      default:
        return Response.json({ error: "unknown_op" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof AccessRowRefused || error?.name === "WorkspaceRowRefused") return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
}

/**
 * Write the index for every refresh hash a kept connection carries, before answering, so a copy that reported done
 * is findable from its old refresh token. A failed index fails the call, and the copy is sent again.
 */
async function indexConnections(store, rows, personalWorkspaceId) {
  if (typeof store.indexRefresh !== "function" || !Array.isArray(rows)) return;
  const hashes = new Set();
  for (const row of rows) for (const hash of [row?.refreshHash, row?.previousRefreshHash]) if (typeof hash === "string") hashes.add(hash);
  for (const hash of hashes) await store.indexRefresh(hash, personalWorkspaceId);
}

/** When a live connection was last used, at most once a minute so a busy client does not write on every call. */
function touch(person, { tokenHash }, now) {
  const row = person.connectionByToken(tokenHash);
  if (row === null || row.status !== "active") return { touched: false };
  if (Number.isFinite(row.lastUsedAt) && now - row.lastUsedAt < 60_000) return { touched: false };
  person.put("connections", [{ ...row, lastUsedAt: now, at: Math.max(now, row.at) }]);
  return { touched: true, connection: withoutHashes({ ...row, lastUsedAt: now }) };
}
