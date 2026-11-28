/**
 * A grant's scopes clamped by the role its person holds: what a live request may do in one workspace
 * (`apps/mcp/src/session.js`, which imports these and is where every request is clamped), and what orientation says a
 * connection may do in each context it reaches (`texContract/identity.cjs` `contextsFor`). Pure, and one copy, so the
 * description and the decision cannot disagree.
 */

const { SCOPE_READ, SCOPE_WRITE, SCOPE_CAPTURE, SCOPE_PRIVATE } = require("./scopes.cjs");

/**
 * The privacy tier this grant was given.
 *
 * **Read from the grant, then clamped by role — never derived from role.**
 * That inversion is the whole change. `visibilityTierForRole(role)` used to
 * live here and answered `private` for every owner, which meant an owner could
 * not connect a client at team level even if that was exactly what they wanted:
 * every note they had ever marked private went to whatever they connected. The
 * tier is now something a person decided at consent time and the grant carries,
 * so an owner who granted `team` gets `team` on every later request, forever.
 *
 * The role clamp stays, and is not redundant with the control plane's. The
 * control plane decides what may be *written* into a grant, at approval time;
 * this decides what a *live request* may do with one, now. Between those two
 * moments a membership can change — and while an owner cannot be demoted, a
 * grant is not the only thing that can go stale. Reading a value the control
 * plane vouched for and enforcing it against the role the control plane
 * reported in the same breath costs one `Set` and closes the gap.
 */
function visibilityTierForGrant(grantScopes, role) {
  if (role !== "owner") return "team";
  return new Set(grantScopes).has(SCOPE_PRIVATE) ? "private" : "team";
}

/** Roles that may change content at all, before per-grant scopes narrow it. */
function roleCanWrite(role) {
  return role === "owner" || role === "editor";
}

/**
 * Grant scopes ∩ what the role permits.
 *
 * Both halves matter and neither implies the other. A read-only grant issued to
 * an owner must not write — the person deliberately connected a client that way
 * — and a full-scope grant issued to a read-only `member` must not write
 * either, because the grant cannot confer authority the membership never had.
 *
 * `SCOPE_PRIVATE` goes through the same intersection as everything else: it
 * survives only if the grant carries it *and* the caller is the owner. It is
 * kept on a capture-only grant too, where it means nothing — the tier only
 * matters to reads — because filtering it out there would be a special case
 * that has to stay in sync with which scopes read, and there is nothing to gain
 * from one.
 */
function effectiveScopes(grantScopes, role) {
  const granted = new Set(grantScopes);
  const effective = [SCOPE_READ];
  if (granted.has(SCOPE_WRITE) && roleCanWrite(role)) {
    effective.push(SCOPE_WRITE, SCOPE_CAPTURE);
  } else if (granted.has(SCOPE_CAPTURE) && roleCanWrite(role)) {
    effective.push(SCOPE_CAPTURE);
  }
  // The tier the person granted, and only for the one role that could grant it.
  // A grant that predates the tier being grantable carries no `context:private`
  // and therefore lands on `team` — a narrowing, which is always allowed, and
  // the only reading that does not leave every legacy grant at full access.
  if (granted.has(SCOPE_PRIVATE) && role === "owner") {
    effective.push(SCOPE_PRIVATE);
  }
  // A grant with no read scope is capture-only: it may drop things into the
  // inbox and may not look at anything.
  if (!granted.has(SCOPE_READ)) {
    return effective.filter((scope) => scope !== SCOPE_READ);
  }
  return effective;
}

/**
 * What this connection may actually do in a context where its person holds
 * `role` — the tier it reads at there, and whether it may write.
 *
 * `writesAnywhere`'s question asked of one context instead of all of them, and
 * here for the same reason that one is: the clamp that answers it is this
 * module's, and a second copy of `effectiveScopes` reasoning is the drift this
 * file exists to prevent. `orient` describes every context a connection
 * reaches, and it described them from the *role* alone — which is neither
 * half of the answer. A read-only grant held by an `editor` was announced as
 * writable; an `owner` was described as reading private notes on a grant that
 * carries no `context:private` and reads that context at `team`.
 *
 * It answers from the grant's own scopes, never the connection's already
 * clamped set, exactly as `sessionForContext` does: re-clamping intersects two
 * roles and would describe a context somebody owns by the role they hold
 * somewhere else.
 *
 * This is a description, never a decision. The gate in `callToolForSession`
 * still decides, from the session `sessionForContext` builds — but both read
 * the same clamp, so what orientation promises and what the call does cannot
 * disagree.
 */
function reachForRole(session, role) {
  const granted = session?.grantScopes || session?.scopes || [];
  const scopes = effectiveScopes(granted, role);
  return {
    tier: visibilityTierForGrant(scopes, role),
    canWrite: scopes.includes(SCOPE_WRITE),
    /*
      Which of the two halves said no, because the remedies differ and
      `callToolForSession` already refuses in exactly these two voices. A grant
      that was never given write is a reconnection the person can make; a role
      that cannot back one up is not, and telling them to reconnect for write
      they can never hold there sends them round a loop that cannot end.
    */
    grantWrites: new Set(granted).has(SCOPE_WRITE),
  };
}

module.exports = { visibilityTierForGrant, effectiveScopes, reachForRole };
