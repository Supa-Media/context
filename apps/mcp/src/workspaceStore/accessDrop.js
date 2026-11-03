/**
 * `ws.write.dropGrantee`: one account's own grants taken out of every row of the workspace, decided and committed in
 * the workspace object, when the account leaves or is removed (as `apps/convex/functions/lib/grants/removeUserGrants.ts`
 * `removeUserGrantsIn` does in the control plane; `object-row-writes.md`, "Access writes in the object").
 *
 * Only `user` grants: an email grant names an address, not a membership. Every record is changed, with no cap: a grant
 * left behind would reach an outsider the owner thinks was removed. The object mints one version for the whole drop,
 * renders the rules once, and hands one change to the mirror (`objectAccessMirror.dropGrantee`).
 *
 * Who may: an owner or an editor (removing a member, as the members op allowed), or the account itself (leaving). Whether the account is still a member is the caller's to know;
 * this takes the grants away either way, which can only narrow. `NOT_READY` as `ws.write.access` gives it.
 */

import { judgingSet, keepRules, WAIT_FOR_MIRROR } from "./accessWrite.js";
import { WriteOpRefused } from "./writeRefusal.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const refusal = (code) => ({ answer: { ok: false, code }, change: null, narrows: false });

export function dropGrantee(ctx, body) {
  if (body.kind !== "user") throw new WriteOpRefused("only an account's own grants are dropped");
  if (typeof body.id !== "string" || !ID.test(body.id)) throw new WriteOpRefused("not an account id");
  const actor = body.actor ?? {};
  if (typeof actor.userId !== "string" || !ID.test(actor.userId)) throw new WriteOpRefused("a drop names its actor");
  // An editor too: removing a member is decided by the members op, which may let an editor do it, and the audit must
  // name whoever removed them. A member may only drop their own grants (leaving).
  if (actor.role !== "owner" && actor.role !== "editor" && actor.userId !== body.id) return refusal("FORBIDDEN");

  const set = judgingSet(ctx);
  if (set === null) return refusal("NOT_READY");
  const holds = (grantee) => grantee.kind === "user" && grantee.id === body.id;
  const touched = set.rows.filter((record) => record.grantees.some(holds));
  if (touched.length === 0) return { answer: { ok: true, version: set.version, dropped: 0 }, change: null, narrows: false };

  const version = Math.max(ctx.now, set.version + 1);
  let dropped = 0;
  for (const record of touched) {
    const grantees = record.grantees.filter((grantee) => !holds(grantee));
    dropped += record.grantees.length - grantees.length;
    ctx.access.writeRecord({ ...record, grantees }, version);
  }
  keepRules(ctx, version);
  const record = { kind: "user", id: body.id, actorUserId: actor.userId, baseVersion: set.version, version, dropped };
  return { answer: { ok: true, version, dropped }, change: { op: "dropGrantee", record, objectAt: version }, narrows: WAIT_FOR_MIRROR, rules: true };
}
