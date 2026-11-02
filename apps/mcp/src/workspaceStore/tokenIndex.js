/**
 * Where an old refresh token's person object is (`workspaceStore/access.js` `tokenIndexName`): one small object per
 * legacy refresh token, `token:<sha256>`, holding the personal workspace id and nothing else. Tokens minted before
 * access moved into the objects (`crt_…`) do not name their object, so a refresh with one asks here first. Written by
 * the person object itself whenever it keeps a connection (`person.connections.put` / `.snapshot`), so a copied
 * connection can never be missing from the index. Set once: an index never moves to another person.
 */

import { objectByName } from "../objectPlace.js";
import { callTexStore } from "../texStore/wire.js";
import { TOKEN_HASH, tokenIndexName } from "./access.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The index object's stub, `null` without the binding. Placed in eastern North America, as every object is. */
export function tokenIndexStub(env, tokenHash) {
  const namespace = env?.WORKSPACE_STORE;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  return objectByName(namespace, tokenIndexName(tokenHash));
}

/** `set(personalWorkspaceId)`, `get()` → the id or null. `null` without the binding. */
export function tokenIndexClient(env, tokenHash) {
  const stub = tokenIndexStub(env, tokenHash);
  if (stub === null) return null;
  const ask = async (op, fields = {}) => await (await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ ...fields, tokenHash })))).json();
  return {
    set: async (personalWorkspaceId) => (await ask("token.set", { personalWorkspaceId })).personalWorkspaceId,
    get: async () => (await ask("token.get")).personalWorkspaceId ?? null,
  };
}

export const isTokenIndexCall = (op) => op === "token.set" || op === "token.get";

/**
 * The index object's side, over `sql` (`exec` → cursor). The object pins the hash it was first asked about and the
 * person it was first given; anything else is refused.
 */
export function serveTokenIndex(sql, op, fields) {
  sql.exec(`CREATE TABLE IF NOT EXISTS token_index (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const read = (name) => {
    const cursor = sql.exec(`SELECT value FROM token_index WHERE name = ?`, name);
    return (typeof cursor?.toArray === "function" ? cursor.toArray() : [])[0]?.value ?? null;
  };
  const refused = (message) => Response.json({ error: "refused", message }, { status: 422 });
  if (typeof fields.tokenHash !== "string" || !TOKEN_HASH.test(fields.tokenHash)) return refused("an index is named by a token's sha256");
  const hash = read("hash");
  if (hash !== null && hash !== fields.tokenHash) return refused("this index is another token's");
  if (op === "token.get") return Response.json({ personalWorkspaceId: hash === null ? null : read("person") });
  if (typeof fields.personalWorkspaceId !== "string" || !ID.test(fields.personalWorkspaceId)) return refused("an index names one person object");
  const held = read("person");
  if (held !== null && held !== fields.personalWorkspaceId) return refused("this token belongs to someone else");
  if (hash === null) sql.exec(`INSERT INTO token_index (name, value) VALUES ('hash', ?)`, fields.tokenHash);
  if (held === null) sql.exec(`INSERT INTO token_index (name, value) VALUES ('person', ?)`, fields.personalWorkspaceId);
  return Response.json({ personalWorkspaceId: fields.personalWorkspaceId });
}
