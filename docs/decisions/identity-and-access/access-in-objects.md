# Who may reach what lives in the objects, one copy

Decided by the owner, 2026-11-01 (23:08–23:30 UTC). The contract every thread
codes against is `apps/mcp/src/workspaceStore/access.js`; this page is why.

## The decision

Members, roles, groups, invites, AI client connections (grants) and shares by
name have **one copy, in the Durable Objects**, never in Convex once a
workspace or person is switched. Clients and the gateway read and write them
there. Convex keeps sign-in, OAuth client registration, billing and audit.

- **The person object** is the personal workspace's own object,
  `workspace:<personalWorkspaceId>`. It keeps `reach` (every workspace and
  group chat the person is in, with role and groups), `sharedToMe` (notes and
  folders shared to them from other workspaces) and `connections` (their AI
  clients' grants, token hashes only). It is the authority for connections.
- **The workspace object** keeps `members` and `invites` and is the authority
  for membership. Once its access is switched, it checks the caller's
  membership itself on every read, so a stale copy of `reach` in a person
  object can never let anyone in.
- Every object is placed in eastern North America (`enam`).

A request is then: token → the person object (who, which workspaces, which
role) → the workspace object (rules and text). No Convex call.

## Tokens name their person object

`cat1.<personalWorkspaceId>.<secret>` (access) and `crt1.…` (refresh), the
secret 32 random bytes. The id is a locator, never proof: the object answers
only for a sha256 it holds, and the hash covers the whole token, id included.
Changing the id sends the hash to an object that does not hold it; changing
the secret changes the hash. Both get the refusal a token that never existed
gets, so no signature is needed and none is kept.

Old tokens (`cat_…`, `crt_…`) keep working. An old access token resolves
through the control plane until it expires (an hour for a client's). An old
refresh token is found through a small `token:<sha256>` object that names the
person object, written when the connection is copied across. New-format tokens
are minted only for a person whose access is already in their object.

## Writes that touch two objects

The authority is written first, then the copy, with one clock (`at`) on both;
the change is done only when both landed (`writeBoth`). Membership: workspace
object first, person object second. So a removed member is refused on their
next request even while the copy is on its way, and a failed copy fails the
call so it is retried, never reported done.

## A switched person's connections

The gateway makes, refreshes and revokes them in the person object
(`apps/mcp/src/oauth/objectGrants.js`). A new connection: the control plane
makes the grant row first, written behind (its id is the connection's, and it
re-checks membership and clamps scopes as it always has), then the object
keeps the connection; if the object refuses it, the row is revoked. A refresh
rotates in the object (client, reach and reuse checks there), then the copy
follows; a copy that fails to follow is logged, never a failed refresh, since
the old refresh token is already spent. A revocation is the object first, then
the copy, because an old access token still resolves through the control plane
until it expires. The control plane refuses to rotate a switched person's grant
and hands a revocation back to the gateway with the grant's id.

The grants the control plane mints itself, the app's own sign-in and a phone's
cards key, follow the same order from the action that mints them
(`apps/convex/functions/lib/accessHandOff/objectMint.ts`): the tokens name the
person object, the row is written behind with the mint's usual checks, the
object keeps the connection, and if it does not the row is revoked and the
mint fails, so no token goes out that the authority does not hold.

Some grants stay decided by the control plane, never held by an object: the
texting grants, and the ones Tex's own scheduled turns run under (a routine,
the daytime check-in, the nightly dream, housekeeping). Each job grant is
minted for one run after the same questions the texting grant asks (a linked
phone that is not paused), and those answers live in the control plane. The
set is `CONVEX_ONLY_CLIENTS` in Convex and `CONTROL_PLANE_CLIENTS` in the
gateway, and a test holds the two equal: a client in one and not the other
would be refused by the object and never written behind, or held by the object
while the control plane still answers its token.

## Deleting an account or a workspace

A mutation cannot call an object, so a deletion that touches any scope on
`object` is queued (`accessTakeAways`) and reported done; an action removes
the members and invites and revokes the connections in every object it
touches (on `dual` too), then deletes Convex's rows behind them in one
transaction (`functions/accessTakeAway.ts`). An object that does not answer is
retried with backoff and the deletion stays queued: Convex never says someone
is gone before their objects do.

A member who leaves because their sign-in domain was dropped goes through the
same queue. A fold (one person's two accounts made one, inside the sign-in
flow that proved it) is the one change written to Convex first, because the
flow goes on using its result: both sides of it are the same person, so an
object briefly holding the old account, or not yet the new one, lets nobody in
who was not already in. Only that fold's own membership rows pass the guard;
the queue then puts and removes them in each object
(`functions/lib/accessHandOff/fold.ts`).

## Convex keeps a read-only copy of membership

Decided by the owner, 2026-11-02: Convex's own membership checks (about 160
call sites in queries and mutations, which cannot call an object) keep reading
Convex's rows, kept as a read-only copy that is written before an object's
change reports done (`functions/accessMirror.ts`). The object stays the
authority; nothing writes the copy except behind it.

The one other way in is a change that only lets someone in. Joining and
invitations are born deep inside Convex mutations (an accepted link, a domain
join, a phone sign-in, a Tex group chat's invite), so at `object` they are
still written to Convex first, and the push puts each joined member and each
changed invitation in the object row by row, as Convex holds it when the push
runs (`functions/lib/accessHandOff/adds.ts`, `functions/accessObjectPush.ts`).
Nobody is let in until the object holds the row. An invitation's link is only
ever checked against Convex's copy, so an invitation revoked, declined or
accepted in Convex is already spent, and the object's list follows. Joining a group, and a new group nobody is in yet, count as joins. Anything
that takes access away or changes it for someone already in (a removal, a role
change) is still refused in Convex and goes to the object first. Leaving a
group, deleting one, and a Tex chat guest leaving the chat's group take access
away too, so at `object` they are queued like a deletion: the queue puts each
leaving member's row without the group in the object, then deletes Convex's
group rows (`functions/lib/accessHandOff/ungroup.ts`).

## What a simplification would cost

- Keeping a second copy in Convex "for safety" is two answers to who may read,
  and the direction they disagree in is a removed person still reading.
- Trusting the token's id, or the person object's `reach`, without the
  workspace object's own membership check, makes a stale or forged locator a
  way in. `apps/mcp/test/accessContract.test.mjs` pins the token format and
  the write order; the person object's tests pin the tampered-token refusal,
  cross-tenant isolation and revocation on the next request.
