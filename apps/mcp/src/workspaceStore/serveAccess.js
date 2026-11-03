/**
 * The workspace object's grant-row calls (`workspaceStore/accessRows.js`).
 *
 * - `ws.apply` with `access`: the push's whole access set, kept in the push's transaction and checked against the
 *   rules the same push carried; the answer is recorded for `ws.access.state`.
 * - `ws.access.check` `{access, rules: {member?, guest?}}`: the same check from a set the caller sends, kept nowhere
 *   (the production dry run, which changes nothing in the object).
 * - `ws.access.state` → `{version, rows, parity}`.
 * - `ws.access.render` `{audience}` → `{rules}`: the rules rendered from the held set, for a parity read. Nothing
 *   judges a read by them yet.
 */

import { AUDIENCES, WorkspaceRowRefused } from "./rows.js";

/** Keep a push's access set and record how its rendering compares with the push's rules. Inside the transaction. */
export function applyAccess(store, set, rulesByAudience, now = Date.now()) {
  if (!store.access) return { kept: false, refused: "this object keeps no access rows" };
  // Never refuses the push it rides on: the rows and rules it carries are what reads are judged by today, and a set
  // this object will not keep is a finding for the parity report, not a reason to leave the workspace behind.
  let kept;
  try {
    kept = store.access.put(set);
  } catch (error) {
    if (!(error instanceof WorkspaceRowRefused)) throw error;
    const refused = { kept: false, refused: error.message };
    store.access.recordParity(refused, now);
    return refused;
  }
  if (!kept.kept) return kept;
  const parity = store.access.check(set, rulesByAudience ?? {}, now);
  store.access.recordParity(parity, now);
  return { ...kept, parity };
}

/** One of the calls above, or null for any other op. */
export function accessCall(store, op, fields) {
  if (op !== "ws.access.check" && op !== "ws.access.state" && op !== "ws.access.render") return null;
  if (!store.access) throw new WorkspaceRowRefused("this object keeps no access rows");
  switch (op) {
    case "ws.access.check":
      return Response.json(store.access.check(fields.access, fields.rules ?? {}));
    case "ws.access.state":
      return Response.json({ version: store.access.version(), rows: store.access.count(), parity: store.access.parity() });
    case "ws.access.render": {
      const audience = fields.audience ?? "member";
      if (!AUDIENCES.has(audience)) throw new WorkspaceRowRefused("not an audience");
      return Response.json({ rules: store.access.render(audience) });
    }
    default:
      return null;
  }
}
