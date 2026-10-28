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

**Staged, with a per-account rollout first.** Once `GOOGLE_AGENT_OAUTH_CLIENT_ID`
(+ `_SECRET`) is set, "Allow AI access" is offered on each account, optional,
in its menu. An account whose owner allows it is read by AI through the agent
grant from then on; everyone else's AI keeps reading through the standard
grant, today's behaviour. That proves the agent client on real accounts
before anything breaks. `GOOGLE_AGENT_CLIENT_ACTIVE=true` is the switch: from
then the agent role mints from `agentGrant` only, a connection without one
answers `refused` and its row says AI cannot read it until allowed. **There is
no fallback to the standard grant after the switch**, and the switch is the
flag alone: switched on with the agent client id or secret missing, AI calls
fail closed rather than quietly reading through the standard grant. Google
refusing an agent grant drops it (the person's own connection stays healthy);
before the switch that account goes back to the standard grant.

**Activation order.** Merge and deploy; set the client pair (synced from the
vault); allow AI access on a test account and check Tex reads through it;
announce the change in the app; then set the switch. Every account that has
not allowed AI access stops being readable by AI at that moment.

**Nothing revokes at Google except disconnect.** Google's `/revoke` ends the
account's grants to the whole project, every client. So a replaced agent
grant is discarded, not revoked (revoking it would also end the new one and
the standard grant), and a consent from the wrong Google account is discarded
too (revoking it would end any connection that account already has here).
Only an explicit disconnect revokes, both grants, and its words say Google
ends Context's access to the account.

**The second consent** reuses the one callback, `https://<APP_ORIGIN>/connect/google`
(production: `https://context.lc/connect/google`, and no other host). It is a
parked attempt like every connect: hashed state, PKCE verifier sealed at rest,
completion secret, ten-minute life, spent before use, owner of the personal
workspace only, redirect pinned to `APP_ORIGIN`. The authorize URL hints the
connection's own address, and a consent from a different Google account binds
nothing.

**Scopes, per client.**

| Client | Asks for | Used by |
| --- | --- | --- |
| Agent | identity; `gmail.readonly`, `gmail.compose`; `calendar.events`; `chat.messages.readonly`, `chat.spaces.readonly`, `chat.messages.create`, `chat.spaces.create` (per product connected) | Tex, AI clients, routines, sync |
| Standard (today) | the same set plus `calendar.events.readonly` | the Meetings view's calendar read; until the switch, AI too |
| Standard (after the switch) | identity, plus `calendar.events.readonly` with Calendar | the Meetings view only |

The agent consent drops `calendar.events.readonly`, which `calendar.events`
covers. An agent grant counts as AI access only when it holds the read
scopes of every product on the connection; a consent with boxes unticked is
asked again. What AI may do (send mail, write the calendar, read or send
Chat, the read-only marks in Settings) is read from the grant AI mints from
(`aiScopesOf`), so after the switch the standard grant's scopes never vouch
for AI, and AI's mail and calendar reads take the same rule: a connection
whose AI grant cannot read the product is named for one more consent, not
read. The standard consent narrows at the switch (`standardScopesFor`), not
before, because until then AI reads through it. From the switch a connect
binds Gmail and Chat by the person's choice, not by reads the standard grant
no longer carries (`standardGrantCovers`); Calendar still needs the calendar
read, which the Meetings view uses. Existing broader grants are left as they
are and nothing is revoked. Tests: `googleConnect/standardScopes.test.ts`.

**The split, by caller**: standard is `meetingCalendar` (the Meetings view) and
`googleReconnect`; agent is every `/gateway/*` Google route (person mail,
calendar, chat, calendar writes, email sends), the scope check and forward
sync. Gateway approvals replayed from the console are still AI acting on the
person's yes, so they stay agent.

What reversing this costs: AI reads under the client the person consented to
for their own use, which is the finding the CASA reviewer raised. The tests
that fail are `apps/convex/__tests__/googleConnect/clientRoles.test.ts` ("after
activation an agent call never uses the standard grant", "switched on with the
agent client missing fails closed", "the agent grant refreshes with the agent
client", "a consent from another Google account binds nothing", "allowing AI
access again ... never calls Google's revoke").
