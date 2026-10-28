# Two Google clients: the person's own use, and AI's (CASA round 2, 2026-10-28)

_Part of [Communications](../communications.md)._

### AI reads Google through its own OAuth client, and never falls back to the person's

Google's review asks that AI and automated access to a person's Google data
go through an OAuth client registered for it, and that a person's own direct
use of an app stay on a standard client. Context does both: Tex, AI clients
through the gateway, routines and anything written into notes for AI to read
act in the `agent` role; the person reading their own calendar in the app's
Meetings view acts in the `standard` role. Every place that mints an access
token says which (`mintAccessToken(ctx, connectionId, forceRefresh, role)`,
`functions/lib/googleConnect/mintTokens.ts`); there is no default.

A refresh token is bound to the client that issued it, so one connection holds
two grants for one Google account: the top-level token fields are the standard
grant, `googleConnections.agentGrant` the agent one. Each refreshes with its
own client.

**Staged.** Until `GOOGLE_AGENT_CLIENT_ACTIVE=true` and
`GOOGLE_AGENT_OAUTH_CLIENT_ID` (+ `_SECRET`) are set, the agent role mints from
the standard grant: that is what every existing grant was issued under, and
switching nothing on changes nothing. Once active, the agent role mints from
`agentGrant` only. A connection without one answers `refused`, the app shows
"Allow AI access" on that account, and the person gives a second consent to
the agent client. **There is no fallback to the standard grant after
activation**, and Google refusing the agent grant drops it (the person's own
connection stays healthy) rather than reaching for the other.

**The second consent** reuses the one callback, `https://<APP_ORIGIN>/connect/google`
(production: `https://context.lc/connect/google`, and no other host). It is a
parked attempt like every connect: hashed state, PKCE verifier sealed at rest,
completion secret, ten-minute life, spent before use, owner of the personal
workspace only, redirect pinned to `APP_ORIGIN`. The authorize URL hints the
connection's own address, and a consent from a different Google account binds
nothing and is revoked at Google. Disconnecting forgets and revokes both grants.

**The split, by caller**: standard is `meetingCalendar` (the Meetings view) and
`googleReconnect`; agent is every `/gateway/*` Google route (person mail,
calendar, chat, calendar writes, email sends), the scope check and forward
sync. Gateway approvals replayed from the console are still AI acting on the
person's yes, so they stay agent.

**Known simplification.** Capability checks after activation still read the
connection's `scopes` (the standard grant's); the agent grant records its own
`agentGrant.scopes`, asked for the same products. If the two ever diverge, the
check moves to the role's grant.

What reversing this costs: AI reads under the client the person consented to
for their own use, which is the finding the CASA reviewer raised. The tests
that fail are `apps/convex/__tests__/googleConnect/clientRoles.test.ts` ("after
activation an agent call never uses the standard grant", "the agent grant
refreshes with the agent client", "a consent from another Google account binds
nothing").
