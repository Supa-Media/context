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

**A canary before the switch (2026-10-29).** Google's Data Access page warns
against sending production traffic to scopes it does not list yet, and the
final consent (identity plus the owned calendar read on the standard client,
AI on the agent client only) has to be filmed and proven before review. So
`GOOGLE_CUTOVER_CANARY_WORKSPACES` names up to three workspace ids that run
as though `GOOGLE_AGENT_CLIENT_ACTIVE=true` and `GOOGLE_CALENDAR_SCOPE=owned`,
while every other workspace runs on the global values (`googleEnvFor` in
`functions/lib/googleConnect/clients.ts`, threaded through every call that
reads either setting: both consents, binding, minting, the scope check and
the app's AI access row). Only the deployment's environment names a
workspace, never a request or a caller; a list of more than three names
nobody, so it cannot quietly become the rollout; `none` is the brake. It is
for synthetic test accounts the operator chose. The cost of dropping it is
filming the final scopes by switching everyone. The cost of letting a request
choose it is a per-call bypass of the switch.
`apps/convex/__tests__/googleConnect/cutoverCanary.test.ts` runs a canary
workspace beside one that is not named and fails if either leaks.

**Waiting for AI access is not a reconnect (2026-10-29).** Where AI mints
from the agent grant (switched on, the canary, or an owner who already
allowed it) and that grant is missing or leaves a product out, the read and
send routes answer `ai_access_needed` with the accounts, apart from
`reconnect` (`aiAccessNeeded` in `lib/googleConnect/aiScopes.ts`; calendar,
mail, sending, drafts and Chat). Tex is told to send the Allow AI access link
(`manage connect_google` with kind `ai`, Connected apps) and never to say
reconnect: after the switch a reconnect gives the standard client a narrowed
grant AI never reads, so the person would go round in a loop. A sign-in Google
stopped honouring stays `reconnect_required`. Before the switch, an account
with no agent grant still reads through the standard grant and waits for
nothing. `__tests__/googleConnect/aiAccessNeeded.test.ts` and the gateway's
`test/googleAiAccess.test.mjs` fail if either answer comes back as a reconnect.

**Count before the switch.** `googleClientsAccess:aiAccessCensus`, run from the
deploy key, returns `{ live, covering, partial, missing, canary }` over live
connections: numbers only, never an address, id or token. `partial` plus
`missing` is how many accounts AI stops reading at the switch.

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

**Every new consent is the minimum, whatever the switch (2026-10-30).**
Google's review asked for exact scope matching and least privilege per
feature, and the submitted union still carried the broad calendar pair. So
every new request, on every deployment and in every workspace, asks for the
final consent: the standard client identity plus, with Calendar,
`calendar.events.owned.readonly` (the Meetings view); the agent client
identity and each connected product's own scopes (`standardScopesFor`,
`agentScopesFor` / `AGENT_PRODUCT_SCOPES` in
`functions/lib/googleConnect/aiScopes.ts`). Ten scopes across both clients,
and no request names `calendar.events`, `calendar.events.readonly` or
`gmail.send`. Gmail no longer carries Chat's scopes: Chat comes with Chat.
`chat.spaces.create` stays in Chat's because sending to somebody the person
has never messaged starts the direct message with `spaces.setup`, which
Google accepts under that scope or the broader `chat.spaces` alone;
`spaces.findDirectMessage` and every read take `chat.spaces.readonly`.

What separates new from old is the row, not the deployment. A connect that
creates a row, or revives one after a disconnect (which revoked every grant),
binds it `consentPlan: "split"` (`planForBinding` in
`functions/lib/googleConnect/consentPlan.ts`), and a split row runs switched
on whatever `GOOGLE_AGENT_CLIENT_ACTIVE` says (`googleEnvForRow` in
`clients.ts`, threaded through minting, binding, the scope check, the app's AI
access row and every claim that reads `aiScopesOf` or `aiAccessNeeded`). Its
AI mints from the agent grant or not at all, its reads and sends answer
`ai_access_needed` until the owner allows AI access, and the app shows it as
`needed` from the first connect. A row made before keeps its route, AI
through the standard grant while the switch is off, for as long as its grant
holds it: `include_granted_scopes` hands a reconnect or an added product back
every scope the account already gave, so neither changes anything for it.
Only a reconnect whose grant no longer covers the old route (a box unticked,
or a grant Google forgot) moves the row to split, since the old route could
not read it anyway. Allowing AI access on such a row also asks for Chat when
its standard grant already sends Chat (it rode on Gmail then), so the second
consent never takes away a feature the person had. Nothing is revoked and no
existing grant is narrowed. `GOOGLE_CALENDAR_SCOPE` is now inert: no request
reads it, and both calendar pairs are recognized on every grant.
Tests: `googleConnect/consentScopes.test.ts` (exact per-client sets under
every global setting, no broad scope on any new request, per product, the
legacy Chat carry-over) and `googleConnect/consentPlan.test.ts` (a new row
binds split and its AI never mints from the standard grant, a row made
before keeps its route through a reconnect, a split row waits for AI access).

**Scopes, per client.**

| Client | Asks for | Used by |
| --- | --- | --- |
| Agent | identity; `gmail.readonly`, `gmail.compose` with Gmail; `calendar.events.owned` with Calendar; `chat.messages.readonly`, `chat.spaces.readonly`, `chat.messages.create`, `chat.spaces.create` with Chat | Tex, AI clients, routines, sync |
| Standard (every new request, 2026-10-30) | identity, plus `calendar.events.owned.readonly` with Calendar | the Meetings view only |
| Standard (grants made before) | what was asked then: every product's reads and writes, the broad calendar pair or the owned one, Chat on Gmail | the Meetings view; while the switch is off and the row is not split, AI too |

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

**Calendar's narrower pair (2026-10-28).** Every Calendar call Context makes
is on the person's own `primary` calendar: `events.list`, `get`, `insert`,
`patch`, `delete`, `events.watch` and `channels.stop`, and no stored setting
names another calendar. Google's discovery document accepts
`calendar.events.owned` for every one of them and
`calendar.events.owned.readonly` for the reads, so the pair in the table above
asks for more than is used. `GOOGLE_CALENDAR_SCOPE=owned` swapped the pair in
every consent until 2026-10-30, when every new request moved to the owned
pair outright (above), so the setting no longer changes anything. Either pair
reads and writes (`canReadCalendar`, `canWriteCalendar`), so a
connection made before needs no reconnect. A consent that kept only a
write scope, of either pair, binds Calendar and reads it, because every
event scope reads (`CALENDAR_EVENT_SCOPES`); identity alone is refused as
incomplete. Tests:
`googleConnect/calendarOwnedScope.test.ts`, including one that fails if a
Calendar request reaches any calendar but `primary`.

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
