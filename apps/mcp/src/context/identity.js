/**
 * Who is acting and which contexts a session reaches: the audit actor, a
 * personal context's display name, the reachable-context list, and a
 * context's addressable name. Moved verbatim out of `src/index.js`.
 */

import { reachForRole } from "../session.js";

/* --------------------------------- MCP ---------------------------------- */

/**
 * Who a write in this context is recorded as.
 *
 * One function rather than two literals, because a cross-context call builds a
 * second store and the audit line on it must name the context it was written
 * in. Two copies of this object is how a note filed into somebody's workspace ends
 * up stamped with the workspace the client happened to connect to.
 */
export function actorFor(session) {
  return {
    workspaceId: session.workspaceId,
    workspaceKind: session.workspaceKind,
    userId: session.actorUserId,
    clientId: session.actorClientId,
    grantId: session.grantId,
    // The two the form tools need, carried the same way and for the same
    // reason: a form response records *who*, and a form's `submit` policy is
    // compared against the caller's role in the context the call was routed
    // to. Both are already on the session `actorFor` is built from, and both
    // are ids and slugs — never a credential.
    role: session.role,
    name: personalNameFor(session),
    /**
     * The client's own name, for the one reader who is a person.
     *
     * `clientId` is an opaque registration id and says nothing to anybody; the
     * activity file is a document somebody opens, and "@sayo's Claude added
     * three notes" is the sentence the feature exists to produce. It is the
     * name the client asserted at registration, so it is display text and
     * never an identity — every authorization decision still reads
     * `clientId`, which is the one the control plane issued.
     */
    client: typeof session.actorClientName === "string" ? session.actorClientName : null,
  };
}

/**
 * The caller's username — their own workspace's slug, with the `@`.
 *
 * A response says who wrote it, and the only name that means anything across
 * contexts is the one in the global username namespace. It is read off the
 * connection's covered contexts rather than passed in, so a submission cannot
 * claim to be from somebody else: `submitted_by` is stamped here, never taken
 * from an argument.
 *
 * **All three clauses are load-bearing, and `role === "owner"` is the one that
 * is easy to leave out.** `session.workspaces` is every context this connection
 * may address, so a personal context in it is *not* evidence that it is this
 * person's: a personal workspace "may gain more members when that person shares
 * it" (`schema.ts`), and `contextsForGrant` puts the context the grant was
 * approved against at the head of the set. A guest who connected to
 * `/@alice/mcp` therefore has Alice's personal context first in their own
 * covered set, and a copy of this predicate missing the role clause named that
 * guest `@alice` — in Alice's note, to Alice. The role settles it because the
 * control plane writes `role: "owner"` in exactly one place, when a workspace
 * is created, for its creator, and an invitation can confer `editor` or
 * `member` and nothing else: one member of a personal context is its owner, and
 * that owner is the person its slug names.
 *
 * `kind === "personal"` is load-bearing for the same reason in the other
 * direction. Usernames and workspace slugs are one global namespace, so a
 * shared context's slug on a caret or a signature reads as a person who does
 * not exist.
 *
 * `null` for a connection whose person has no personal context — which is not
 * a state the product produces, but is one a self-hosted deployment or a stale
 * grant can, and the callers refuse or fall back rather than invent a name.
 * Never `@null`: an absent slug is a missing handle, not a handle spelled
 * "null", in a namespace where that is a word somebody could hold.
 */
export function personalNameFor(session) {
  const own = (session?.workspaces || []).find(
    (entry) => entry.kind === "personal" && entry.role === "owner" && entry.slug
  );
  return own ? `@${own.slug}` : null;
}

/**
 * The contexts this connection can address, as `orient` needs to name them.
 *
 * Request-scoped metadata on the store, like `store.actor`, because the tool
 * layer takes a store and a scope and nothing else — and a reach an agent is
 * never told about is a reach nobody uses.
 *
 * A covered context with no slug is dropped rather than listed: the name is how
 * a tool call addresses one, so an entry nothing can be passed as would be an
 * offer that refuses.
 */
export function contextsFor(session) {
  return (session.workspaces || [])
    .filter((entry) => typeof entry.slug === "string" && entry.slug !== "")
    .map((entry) => {
      /*
        The role is what this connection's person holds there; the reach is what
        *this connection* may do with it, which is the role intersected with the
        grant's own scopes. Both travel, because orientation describes contexts
        it does not open — the ones past the fan-out cap, and every one of them
        when `orient` was itself addressed elsewhere — and a description drawn
        from the role alone is wrong in both directions.
      */
      const reach = reachForRole(session, entry.role);
      return {
        name: `@${entry.slug}`,
        role: entry.role,
        kind: entry.kind,
        current: entry.workspaceId === session.workspaceId,
        canWrite: reach.canWrite,
        grantWrites: reach.grantWrites,
        tier: reach.tier,
      };
    });
}

export function contextNameFor(session) {
  return `@${session?.workspaceSlug || session?.workspaceId || "context"}`;
}
