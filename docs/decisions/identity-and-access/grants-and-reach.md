# Identity and access — grants and reach

### The privacy tier is a scope on the grant, never an inference from a role

`visibilityTierForRole(role) => role === "owner" ? "private" : "team"` used to
decide, per request, how much of a context an AI client could see. It meant an
owner could not connect a client at team level: whatever they connected saw
every note they had ever marked private, and no setting, scope, or screen
changed that, because there was nothing to change. The owner of this product
asked for exactly this and there was no answer.

The tier is `context:private`, an ordinary member of `SUPPORTED_SCOPES`,
recorded on the grant and read back by `visibilityTierForGrant(scopes, role)`.
Four things about that are load-bearing:

- **It is the only representation of itself.** No `visibilityTier` column
  beside it. A tier stored twice is a tier that can disagree with itself, and
  the direction that disagreement fails is "an AI client reads more than the
  person allowed".
- **Absence means `team`, and that is the migration.** A grant issued before
  the tier existed carries no `context:private`, so it narrows. Reading an
  unmarked grant as private would leave every pre-feature grant at full access
  forever — on exactly the grants nobody was ever asked about.
- **The role still clamps, and the clamp is not the tier.** Reading the grant
  says what a person chose; the clamp says what their membership can still back
  up. Collapsing the two in either direction restores the old bug or invents a
  new one.
- **The consent screen defaults to `team` for every request that does not name
  the tier, owners included.** The old behaviour was private-by-default with no
  way out; a switch next to the old default would have changed nothing.
  Approving is opting in.

  **Amended 2026-09-07: a request that names `context:private` opens on
  `private`.** As first written this bullet said "for everybody", and that
  extra word was the defect rather than the protection. Every other requested
  scope arrives ticked — the screen shows what the client asked for and
  narrowing is something a person does, not something they have to undo — while
  the tier was the one requested thing that arrived silently un-granted. So a
  client that asked for it was approved without it and behaved differently ever
  after, with nothing anywhere saying why. The desktop shell is where that
  stopped being cosmetic: its grant's tier decides what a meeting is *filed as*
  (`publishMeetingNote`), so the silent narrowing filed a person's meeting notes
  team-visible — the privacy default *this bullet exists to prevent*, arrived at
  by approving exactly what the screen displayed.

  What it costs, stated rather than discovered: a client can now put the screen
  on `private` by asking for it, so the protection against private-by-default is
  no longer the default alone. It is that the request has to say so, that the
  screen draws the tier as its own control with the elevated read sentence
  ("including the ones you marked private"), that moving it is one tap, and that
  a client which asks for nothing — `DEFAULT_REQUESTED_SCOPE` is `context:read
  context:write` — cannot reach the branch at all. The role clamp is unchanged:
  an editor asked for the private tier is still offered `team` alone.

  **And a client must not trust the request as the answer.** The second half of
  the same fix is in `apps/desktop`: `connectMachine` records the scope the token
  endpoint returned verbatim (the `|| DESKTOP_SCOPE` fallback that stood there
  made the record echo the request), and `postEntry` refuses to send a meeting on
  a grant that does not carry the tier, holding it with a reason on the machine
  card instead of letting the gateway file it at the wider one. `defaultTierFor`
  in `features/consent/scopes.ts`, `grantCoversMeetings` in
  `core/sync/connection.ts`, and the checks named in `docs/decisions/desktop.md`.

There are three clamps, at three moments, and they are not redundant:
`applyApproval` decides what may be *written* (a person, in a browser),
`createGrant` re-clamps what the gateway *relays* (a Worker, which may be
compromised or newer than this deployment), and `effectiveScopes` decides what a
*live request* may do (membership can change after both). `functions/lib/consentScopes.ts`
is the control plane's copy of the vocabulary; `apps/mcp/src/session.js` keeps
its own because the gateway is dependency-free, and the mobile screen's mirror
is asserted against the control plane's in `__tests__/consentScopes.test.ts`
rather than claimed in a comment.

Adding a scope means adding it to `SUPPORTED_SCOPES` in `session.js` — which
`oauth.js` imports, so discovery and `/oauth/authorize` validation cannot learn
about it separately. A client that follows discovery to a scope the
authorization endpoint then rejects is a client that concludes the server lied.

### A third-party OAuth callback carries a secret the browser kept, not just `state`

`state` travels in the authorize URL and comes back in the callback, so
**whoever built the URL knows it.** That is fine against an interceptor and
useless against an initiator, and the initiator is the case that matters here:
somebody can start a perfectly legitimate connect for a workspace they really
do own, send the resulting authorize URL to another person, and have that
person's account bound to *their* context. PKCE cannot see it — the verifier is
genuinely the initiator's, so it matches — and neither can a redirect
allow-list, because the attack uses the real redirect.

RFC 6749 §10.12 asks for `state` to be **bound to the user-agent that started
the flow**. A `state` that is only an unguessable server-side lookup key is not
that. So `startDropboxConnect` mints a second value, returns it to the starting
browser alone, and `completeDropboxConnect` requires it back:

- it **never travels through the provider**, which is the whole property;
- it is stored hashed, and compared after the attempt is deleted, so a wrong
  one spends the attempt exactly as a failed exchange does and cannot be
  retried against a `state` somebody holds;
- a wrong secret, an unknown `state` and an expired attempt are **one answer**;
- an attempt parked before this existed carries no hash and is refused rather
  than trusted — bounded by the ten-minute TTL, and the safe direction.

**It is deliberately not a session.** `#76` removed the session gate on this
callback because the OAuth round trip can drop the session, and the sign-in
wall that followed outlived Dropbox's single-use code on the first live
connect. Browser storage binds the browser without asking who is signed in, so
that fix stays intact. A browser that cannot keep the value cannot complete a
connect, which is the honest outcome rather than a fallback.

The same shape is owed to every third-party connect this repository grows.
The Google flow was written from this one, cited its older argument verbatim
(*"it applies here unchanged, PKCE pair and all"*) and inherited the gap with
it; it carries the same `completionSecret` now. **A connect that cites this
paragraph is citing the binding, not the absence of a session** — the two
travelled together once and that is exactly how the gap spread.

**Four flows, and the fourth is why this is a guard rather than a habit.**
Dropbox, Gmail and Calendar were bound by hand, one file at a time, and Google
Chat — a separate `startChatConnect` in `chatProduct.ts`, sharing the same
attempt table — was left completing on `{state, code}` alone. The attack
demonstrated against it bound a stranger's Chat grant, which reads every space
they are in. So the rule is enforced by shape rather than by memory, in
`apps/convex/__tests__/connectBinding.test.ts`: a **table** storing a
`hashedState` stores a `hashedCompletion`; a **public action** taking
`{state, code}` declares `completionSecret`; an **internal mutation** keyed on
`hashedState` requires a `hashedCompletion`. The subjects are read from
Convex's own exported validators and the discovered lists are asserted, so a
fifth provider arrives as a failing diff and a rule whose subjects vanished
fails instead of looping over nothing.

**What the binding forbids, stated rather than discovered later.** Finishing a
connect in a different browser, a different device, or a private window from
the one that started it: refused, permanently, and that is the point. A browser
with site data blocked cannot connect at all — it is told so specifically,
locally, from a fact only it has, because "start it again" is false advice
there. Two connects started from one browser share one `localStorage` key, so
the second start invalidates the first tab's callback. And the callback spends
the secret before the exchange is attempted, so a *transport* failure there
(not a refusal) costs the person a restart rather than a reload. All three are
the shape of the binding, not defects in it; keying the stored value by `state`
would relax the middle one without weakening anything, if it ever bites.

**It does not replace the product discriminator on `googleConnectAttempts`.**
That check answers a different question — an attempt is for the products it
parked — and the case it covers is one the binding structurally cannot see:
there, the person completing *is* the browser that started it, and what is
wrong is the consent screen they were shown. Both checks stand, and the order
matters for the tests that prove them: the binding is checked first, so a test
of the product rule that omits the secret is refused before `products` is ever
read. That is not hypothetical — this change caused it, and for one commit the
discriminator in all three Google flows was unguarded while its tests still
passed.

### The same derived-subjects shape closes a teardown gap, not just a binding gap

The pull request that added `googleConnectAttempts` (and the binding above)
named a second miss and left it out of scope: `deleteAccount`'s workspace
cascade swept `dropboxConnectAttempts` but not `googleConnectAttempts`, so a
parked Google connect — verifier and completion binding both — outlived a
deleted workspace until its own ten-minute expiry. Small window, real
half-credential, and exactly the shape the binding guard above already named:
"a fifth provider arrives as a failing diff" only if the guard's subjects are
*discovered*, not hand-listed, because a hand list is precisely what let the
second provider slip through the first time.

So `functions/lib/connectAttempts.ts` reads the same signal
`connectBinding.test.ts` reads — a table's own schema validator — but asks a
different question of it: not "does this table declare `hashedCompletion`
beside `hashedState`" but "does this table declare both `workspaceId` and
`encryptedVerifier`", which is what makes a row a parked half-credential
*somebody's workspace* can outlive. `deleteWorkspaceCascade` sweeps whatever
that derivation finds in one loop, so `dropboxConnectAttempts` and
`googleConnectAttempts` are not two call sites to keep in sync — they are one
answer to one question, and a third provider's attempts table answers it
without anyone adding a line for it.

**The Google connection itself (`googleConnections`) needed the same audit,
by hand rather than by derivation.** Unlike an attempt, a live connection is
not a transient row with a matching schema shape shared by every provider —
it is `storageBindings`' direct sibling, sealing a standing refresh token
against a workspace with no expiry of its own. It was not part of the eleven
tables the cascade already swept, and the fix mirrors `storageBindings`'
Dropbox handling exactly: schedule the revoke, envelope in the scheduler args,
then delete the row — one workspace can hold several (one per connected
address), so every still-live one gets its own scheduled revoke rather than
one call for the workspace.

**What a full audit of the cascade found and left alone, deliberately.**
`workspaceDataKeys` stays for the reason `docs/decisions/encryption.md`
already gives — it opens the customer's own notes, and deleting it is an open
product decision, not a sweep to add. `oauthAuthorizations`
has no `workspaceId` index, so an authorization a co-owner approved for a
workspace somebody else just deleted is reached by neither sweep — bounded
the same way `dropboxConnectAttempts` always was before this change, by a
ten-minute expiry and an hourly sweep, and left open for the same reason:
closing it needs a schema change, not a sweep addition. What makes that
bound sound rather than merely short is one line further down the path:
redeeming such a code *does* mint a grant (`consumeAuthorizationCode` checks
the code, the client and the clock, never the workspace), but the grant
cannot then authenticate anything, because `resolveLiveGrant` re-reads both
the membership row and the workspace row on **every** request and returns
`null` when either is gone — and the cascade deleted both. The residue is an
inert `oauthGrants` row for a workspace that no longer exists, not reach into
one. `usageDaily` and
`usageActiveDaily` hold no credential and no customer content by construction
(`docs/decisions/storage-and-credentials.md`, "Usage is counted, never
logged"), so a stale `workspaceId` in a count is not a capability anyone can
use — deleting them would only falsify a day that genuinely happened. All of
this is spelled out where an operator reading the cascade will actually find
it: the enumerated list in `deleteWorkspaceCascade`'s own doc comment in
`apps/convex/functions/account.ts`.

**`searchIndexes` is the one row a teardown must press a switch on rather than
delete.** A row with a `databaseId` names a live, billed Cloudflare D1
database holding a projection of that context's notes — path, title, headings,
tags and body chunks (`apps/mcp/src/search/d1/project.js`) — and that database
is reachable only through this row. So deleting the row is not a teardown of
the index, it is the permanent abandonment of it: the customer's note text
left in our infrastructure with nothing pointing at it. Leaving the row alone
has the same ending by a slower road, because the only path that deletes the
remote database is `fastSearch.ts`'s `disable`, and after a cascade there is
no owner left who can press it. The cascade therefore does what `disable`
does — mark the row `optedIn: false` / `releasing`, which serves nothing from
that moment, and schedule `fastSearchProvision.releaseIndex`, which deletes
the database and then removes the row through `forgetIndex`. Scheduled, not
called, for the same reason the two revokes are: that action opens the
platform's D1 token. **The residual, stated rather than papered over:** if the
release fails (token unconfigured, Cloudflare down) the row stays `releasing`
and nothing retries it today — `sweepStalledBackfills` only picks up
`backfilling` rows. That is strictly better than the `ready` row it replaces,
because the row is the handle a retry needs and it is now marked as owing one,
but a `releasing` sweep is the honest next step.

**What still escapes the derivation, and the second guard that catches it.**
`connectAttemptTables` matches one field pair, so a connect attempt that
spells its verifier `encryptedCodeVerifier`, one scoped by `userId`, or one
that nests the envelope inside an object field is invisible to it — and a
live *connection* table for a new provider (the `googleConnections` shape) was
never in its scope at all, which is exactly how that miss happened. So
`__tests__/cascadeCoverage.test.ts` asks the wider question directly: every
table in the schema that declares a `workspaceId` **and** any `encrypted…`
field must be swept by the cascade or listed there as a deliberate exception
with its reason. A new provider's connections table fails that test the day
it is declared. Two shapes still get past both, and neither is claimed: a
sealed field that does not begin with `encrypted`, and one nested inside an
object field.

### A first-party signed shell may have its own grant approved by the session hosting it

The owner, on the first end-to-end desktop capture (2026-09-07): *"I don't love
this setup; when installing Granola I didn't have to 'connect' a machine, things
just worked."* He was signed in inside the app's own window — #312 had already
moved the approve screen there — and the app still asked him to authorise the
same person, on the same machine, to the same context.

The step goes and the grant stays. `approveOwnMachineGrant` approves a parked
authorization request for the caller's **own** session, with no screen, and
everything the grant is is unchanged: an `oauthAuthorizations` row armed by the
same `arm` the consent screen's approval uses, one OAuth client per machine,
`context:write context:private` and nothing wider, an audit row naming the
person and the machine, and the same revocation path in the connections list.
Non-negotiable #4 is about grants being per-client and revocable, and it is
untouched. What is new is who answered the question.

**What makes that acceptable here, in the order it matters.**

1. **The code can only be delivered to the person's own machine.** Every
   registered redirect URI, and the request's own, must be
   `http://127.0.0.1[:port]/<path>` — the literal, never `localhost`, which is a
   name somebody else's DNS can answer. This is the condition that carries the
   weight: an attacker off this machine has nowhere to receive the code, whatever
   else they arrange, and PKCE still binds it to the process that started the
   flow.
2. **The person is signed in, in a window at the pinned origin, in a binary
   they installed.** The session is the console's own, at our origin, in the
   shell's `persist:console` partition. Nothing about it is sent anywhere: the
   page calls a mutation as itself, and the shell receives only its own grant.
3. **The request is exactly the default.** Set equality with `context:write
   context:private`, so a request that added `context:read`, dropped the tier,
   or spelled it `*` is a different question and gets the screen that asks it.
4. **The approver's role can grant that tier.** An editor or a member cannot
   hand over `context:private`, and auto-approving them would mint the narrower
   grant they never chose — which is the tier defect amended above, arriving by
   another door. They get the screen.

**What auto-approving *any* client would cost, which is why none of this is a
general mechanism.** Consent is the one moment a person sees which client is
asking, what it wants, and which context is at stake. Auto-approve on "the
caller is signed in" and an OAuth client becomes something that gets access by
asking at a moment when a browser tab happened to be open — the confused-deputy
shape the whole consent screen exists to prevent, with our name on it. The four
conditions above are the opposite of a general rule: they say *this* software,
delivering to *this* machine, at *the* default, for somebody whose role already
covers it. Everything else, including the desktop shell itself asking for
anything wider, goes through the screen.

**The declaration is client-asserted, and this file says so rather than
implying otherwise.** The shell registers RFC 7591's `software_id`
(`DESKTOP_SOFTWARE_ID`, plumbed through `plugins/context`'s `registerClient` and
the gateway's `/oauth/register`), and registration is unauthenticated by
construction — so anything that can register can claim the string. What it buys
is **scope**, not authentication: no client that did not declare itself the
shell is ever auto-approved, so the blast radius of this feature is one declared
id rather than "every OAuth client that reaches a signed-in console". A hostile
local client that *does* claim it still has to (a) get the code to a loopback
listener on the person's own machine, (b) settle for the default scope, and (c)
have code running as the console origin call the mutation for its request id —
and anything with (c) could already have driven the Approve button.

**The link (c) hangs from is that the request id reaches the page over the
bridge and nowhere else**, so it is held by a test rather than by the shape of
the current code: `apps/mobile/__tests__/meetingsDesktop.test.ts` drives the
card with `?request_id=`, a fragment, a `postMessage` and a global all naming a
forged request, and reads both source files for a second way to learn one. A
deep link that seeded this card from a URL would be a confused deputy with a
signed-in session behind it, and it goes red there.

**The residual, stated rather than left to be found.** Somebody signed in who
holds a live request id can *spend* it — it grants **their** context, never the
person whose machine parked it, and the code it produces needs a PKCE verifier
that never left that machine. What it costs the other person is the approve
screen on a second parked request, which is where every other refusal here ends
too. Getting the id in the first place means being the process that followed the
parking redirect, or code running as the console origin — and either of those
could already have driven the Approve button.

**Rate limited on successful mints, three an hour per person.** A refusal rolls
the counter back with its transaction, which is the right unit: every success is
a permanent client row and a live credential, and connecting machines is
something a person does once per machine.

`functions/lib/machineGrant.ts` is the decision as a pure function,
`__tests__/ownMachineGrant.test.ts` proves each refusal, and the flow's two
halves are `apps/desktop/src/core/shell/autoGrant.ts` and
`apps/mobile/features/meetings/machineApproval.ts`. `docs/decisions/desktop.md`
carries what the shell gives up for it and what it deliberately does not.

### One connection reaches every context its person belongs to

Asked for by the owner (2026-09-02) after somebody invited into a workspace found
their agents could not open it: *"If I have access to someone's brain, my MCP
should be able to connect to it."* This **reverses** the section that stood here
a day earlier, which recorded the opposite as deliberate — that a grant covers
one context, and that widening it "is not a cleanup, it is a change to what a
consent means". That objection was right about what it costs and was overruled
with the cost stated, which is the only way it should ever have been settled.

`resolveGrantByAccessToken` returns every context its person is a **live
member** of, and `sessionForContext` in the gateway addresses one of them from a
tool call's `context: "@name"`. Read live rather than frozen at consent: a workspace
shared with you afterwards is reachable from the client you already connected,
and one you are removed from stops being reachable on the very next call —
`resolveLiveGrant`'s rule 5, applied to the whole set.

**Reach is not permission, and only reach widened.** Every clamp that applied to
the connection's own context applies to the addressed one, from the grant's
scopes and the *target's* role: `effectiveScopes` makes a `member` read-only
wherever they are a member, and `visibilityTierForGrant` reads `team` for
anybody who is not that context's owner, so no private note of somebody else's
is reachable by any client, ever. What a connected client can do in your workspace
is exactly what you can do in it yourself.

Five things hold it, and each fails a test if removed:

- **The clamp reads the grant's scopes, never the connection's clamped set.**
  `session.grantScopes` exists for this. Re-clamping an already-clamped set
  intersects two roles, so somebody who connected to a workspace they are a `member`
  of would lose write in a context they *own* — fails closed, and reads as a
  permission bug in the wrong place. The fixture that catches it is a person
  whose home context is somebody else's workspace.
- **The tier is re-read for the target role**, not carried across. Carried, an
  owner's `private` connection reads private notes in a context they are only a
  member of, which is the leak this whole section has to not be.
- **Routing happens in `callToolForSession` and nowhere else.** That is the rule
  "authority is decided once" applied to a second dimension: a tool, or a path
  parser, resolving its own context is a second authority decision, and the
  second one is the one that drifts. `context` is stripped from the arguments
  there, so no tool can ever read it as an input.
- **`openStorageBinding` selects inside the token's own set.** The id the
  gateway sends is compared against the contexts that token resolves to and is
  then dropped; what reaches storage is the id off the row. The shape that must
  never come back is the one `structure.test.ts` still pins — an id used as a
  *lookup key*, which needs no membership at all. **This is a real widening of
  what a compromised gateway plus one valid token can reach**: from that
  person's one context to that person's contexts. It cannot walk to anybody
  else's, and that bound is the whole of what is left, so nothing may weaken it.
- **The refusal is uniform.** A context you are not in, a name nobody has
  registered, and a malformed name are one answer — the refusal
  `selectWorkspace` already gave the URL form, because a distinguishable one is
  an existence oracle over a global namespace.

**What it costs, stated rather than left to be rediscovered.** The consent
screen names one context and the grant covers all of them, so the screen had to
say so — it now reads "It can reach every context you belong to, with the access
you have in each — including ones shared with you later", and the picker chooses
where a client *starts* rather than what it may touch. That sentence is the
whole mitigation for the objection this reverses, and it is why the copy is not
a detail: an unattended credential on an old laptop reaches contexts joined
after it was approved.

The hook is the exception, and by construction rather than by care: it holds
`context:capture` alone, which cannot reach `/mcp` at all, and `/inbox` takes no
`context` argument and opens no second store. So the credential this product
leaves lying around is the one that still reaches exactly one context. Adding
routing to `/inbox` would spend that for nothing — a capture lands in
`0-inbox/`, which is what that folder is for.

Whoever wants the rest narrowed again should add a picker to
the consent screen and build the set from what was ticked, rather than making
`resolveGrantByAccessToken` narrow: the gateway would then hold reach the
control plane disagrees with.

**The named `/@<slug>/mcp` URL survives with a smaller job.** It is no longer
how you get *at* a context — it decides which one a client starts in, since the
grant's own context is what an unaddressed call resolves to. `endpoints.ts`
still refuses to print a URL the gateway would not read back, for the reason it
gave when it was the only way in: `splitWorkspacePath` answers a segment it
rejects by ignoring it, so a wrong named URL does not fail, it quietly connects
somewhere else.

**And the discovery half is the feature.** An agent will never go looking for a
context nobody told it about, so both surfaces that reach a model before it
decides anything name them: the connect-time `instructions` and `orient`.

`instructions` lists names and roles only. It is built during a handshake that
must never fail, on every connection, so it opens no bucket at all.

**`orient` reads each of their front pages**, which was the owner's next
correction (2026-09-02) and is right: a name an agent cannot judge is a name it
never follows, and `index.md` is the one file that says what a context is for.
Four rules hold that, and each fails a test:

- **Each page is read at that context's own clearance**, from the session
  `openContext` clamps and that context's own `privacy.md` — so a front page its
  owner has not shared is absent, and the line says "no front page visible to
  you there yet" rather than pretending the context is empty. Note what that
  means in practice: the scaffolded manifest starts everything private,
  `index.md` included, so a member sees nothing until the owner shares it. The
  common useful case is somebody's own several contexts.
- **It is bounded at six, and a short list says so.** Each context costs a
  control-plane round trip and two reads against a Worker with a subrequest
  ceiling, so an unbounded fan-out is how orientation starts failing outright
  for the people who have the most of it. Past the cap the rest are still named,
  because a name is free.
- **One context that will not open cannot take the others down.** A revoked
  binding or a broken manifest is a line on its own row; the answer stands.
- **An `orient` already addressed into another context reads none of them.**
  It is handed a store with no opener, so it names the rest: one tool call opens
  one context beyond its own, never a chain.

### One context is pinned for everybody, and the pin is reach rather than membership

`@context-lc` — our own workspace: the docs, the changelog, the bug tracker —
is in every account's context list without an invitation, read-only, with the
form tools still open to it. Asked for by the owner (2026-09-16): *"pin the
@context-lc workspace to everyone's context, and make them viewers (should
still be able to submit bug requests and stuff)."*

`vocabulary-and-workspaces.md` had already described it as "the shared context
every user is a member of", and that was a sentence rather than a mechanism:
nothing outside `createWorkspace` and `acceptInvitation` had ever written a
`workspaceMembers` row, so the context everybody was supposedly in had exactly
the people who had been invited to it one at a time.

**Nobody gets a membership row, and that is the decision rather than an
optimisation.** `listMembers` returns every member's name and email to any
member. A row per account would make that query a directory of everybody on the
platform, readable by everybody on the platform — enumeration with the contact
details attached, which is precisely what non-negotiable #4 refuses. So the pin
is computed, in three narrow places, and `requireWorkspaceAccess` — the tenant
boundary, ~90 call sites — is not touched:

- `contextsForGrant` appends it to what an MCP session covers, at role `member`,
  last and after the cap. **The gateway needed no change at all**, which is the
  property that made this cheap: `sessionForContext` clamps it like any other
  covered context, and `openStorageBinding` picks the binding to open out of
  that same set — so a pin added anywhere else would resolve a session and then
  fail to open a store, which presents as a context that is visible and empty.
- `listMyWorkspaces` appends it flagged `pinned: true`, after the sort. It is
  older than almost every account that will see it, so sorting it in by
  `createdAt` puts it at the *head* of everybody's list, above their own
  workspace.
- `authorizeFileAccess` grants it on the `minimum === "member"` branch only. The
  five callers that ask for `member` are exactly the five reads; everything that
  changes a byte asks for `editor` or `owner` and goes to `requireWorkspaceRole`,
  which knows nothing about the pin. A pinned reader is therefore refused a
  write by the same code that refuses a stranger, rather than by a second check
  somebody could forget to add.

So the member list, the audit trail, billing, the storage binding, grants,
shares, groups and invitations all answer a pinned reader exactly as they answer
somebody who has never heard of the workspace. Blended search is untouched as
well: `searchContexts` only ever authorizes contexts `searchableContextsFor`
already returned, and that is driven off real memberships — the pin does not
point every account's cross-context search at one bucket.

**"Viewer" is the `member` role, and there is no fourth one.** `member` is
already read-only, `effectiveScopes` already drops `context:write` for it, and
`participatesInForms` already carves out a form answer as the one write it
permits — written in so many words so that "a view-only workspace" is not
"useless for collecting a bug report". That carve-out is what makes the bug
tracker work, and it is a plain ```` ```form ```` fence with `submit: member` in
a note in our bucket: nothing about it is special-cased for us, and any customer
can write the same line in their own.

**A real membership always wins.** The people who run that workspace are `owner`
and `editor` in it through ordinary invitations, and the row appears once — two
would make `sessionForContext`'s `.find()` answer with the pinned `member` one
and silently demote them. The test that catches the other direction is an owner
*reading* in the pinned context: it must come back `private`, and a resolver
that skipped the membership check would answer `team` and hide every private
note from the people who wrote it. A sabotage sweep found nothing covering that
case; two tests were added for it.

**There is no opt-out**, decided with the cost stated: pinned means pinned. It
needs no code, because `leaveWorkspace` deletes a membership row and there is
none — it answers `{ left: false }` and the context is still there. If that ever
stops being true, a test fails.

**The slug is a hardcoded constant**, also decided rather than defaulted. The
name is already in this repository in prose and in `functions/lib/names.ts`, so
naming it in `packages/shared` discloses nothing new. The cost lands on
self-hosting, which is a supported path: a self-hoster gets a pinned context
only if a workspace with that slug exists in *their* control plane, and on a
fresh deployment none does — `pinnedContextWorkspace` answers `null` and the
feature is simply absent, which is the right answer for somebody who has no
reason to want our bug tracker in their rail.

**But the slug SELECTS that row and does not MAKE it the pinned context.**
`functions/lib/names.ts` reserves this name's lookalikes and deliberately not
the name itself — *"what protects a name we hold is holding it"* — because a
reserved name is refused for everyone including us, and we could then never
recreate this workspace after a delete. That argument is about a **handle**, and
it stands; pinning is what turns the same string into a **trust anchor**, which
is a different question that the first decision did not answer. Anywhere the
name is not already held — a self-hosted control plane, a fresh staging
database, this one after a delete frees it — the first account to claim
`context-lc` would be pinned into every rail and every session: their notes
reaching every user's agent under a handle that reads as ours, and, because
`participatesInForms` asks only for a write-scoped grant and a non-empty role, a
form of theirs taking submissions from any user's client.

So the resolver asks for two things the account claiming a name cannot give
itself. The workspace must be **`shared`** — a personal context has a mailbox,
an ingestion alias and an owner it is deleted with, and `pinnedContextRow`
reports the row's own kind. And somebody this deployment already trusts must
stand behind it: a **staff** creator or owner, by `ADMIN_EMAILS`, which lives in
the Convex environment exactly because nothing this codebase executes can write
it, and which unset means nobody. Neither is new configuration where this
already works, and both fail in the direction that leaves a self-hoster with no
pinned context rather than with somebody else's.

**What the console had to be told.** A row nobody joined breaks rules that were
correct while every row was the reader's own. `needsOnboarding` counts
`listMyWorkspaces` to ask "is there anything here for you", so the pin made that
count never zero and a brand-new account rendered the console instead of
`/welcome` — no claimed name, no bucket, no route to either. `defaultContext`'s
`?? contexts[0]` fallback exists for somebody who owns nothing, which is exactly
who signs in with the pin as their only row, so signing in landed them in our
docs. And eleven member-scoped subscriptions would have failed silently behind
`usable()`, each rendering `undefined` as "still loading" forever. One
derivation — `membershipContextId`, `null` when the selection is pinned — turns
all eleven off, and `useFileBrowser` alone keeps the real id.

**Drawn as somebody else's workspace, in three quiet things rather than one loud
one**: last in the rail under a hairline, with the only line of prose any row
gets and a `read-only` mark in the palette's existing somebody-else's-access
violet; on a phone, a divider and the pill's own tint, since a 34pt row has
nowhere to put a sentence. Both orderings pin it last themselves rather than
trusting the order the control plane sent, because the separation is
*positional* — "everything after this is different" is only true while exactly
one row follows it. A badge shouting READ-ONLY was the obvious answer and is the
wrong one: it would make another party's workspace the loudest row in somebody's
own console, and what has to be unmistakable is whose the notes are.
