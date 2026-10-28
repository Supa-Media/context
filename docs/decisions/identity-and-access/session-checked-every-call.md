# Signing out ends a token at once: the session is checked on every call

Decided 2026-10-28 (CASA round 2, post-sign-out credential window).

`@convex-dev/auth` gives each sign-in a session row and an access token (a
JWT, one hour) whose subject is `userId|sessionId`. Its `getAuthUserId` reads
the subject and nothing else, so after sign-out deleted the session row, a
token issued before it kept reading and writing every Convex function for the
rest of its hour. `@supa-media/convex`'s `requireAuthId` wraps the same call.

Every Convex function now takes the person from `functions/lib/signedIn.ts`
(`getAuthUserId`, `requireAuthId`), which also loads the session row and
answers signed out when it is gone, expired, someone else's, or not named:

- A query or mutation reads the row itself. In a query the row joins the read
  set, so a live subscription re-runs and goes blank the moment its session is
  signed out.
- An action or HTTP action has no database, so it asks the internal query
  `liveSession.isLive`, which runs under the same identity.

What a simplification would cost: going back to the library's helper, or
adding a module that imports it, re-opens the hour. `__tests__/signedIn.test.ts`
refuses any import of the unchecked helpers outside `signedIn.ts`,
`liveSession.ts` and `lib/emailProof.ts`, and proves a signed-out token is
refused by a query, a mutation and an action.

Not covered here: MCP and gateway access tokens are `oauthGrants`, revoked per
client and checked by the control plane on every request already. The
upstream wrapper (`@supa-media/convex` `requireAuthId`) should grow the same
check in supa-framework; until it does, this repository does not use it.
