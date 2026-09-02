# Identity, grants, invitations, and ingestion

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Ingestion is on the apex, which makes the reserved-name list a security control

Capture addresses are `<username>@context.lc`. A user who claimed `support`
would receive mail sent to support@context.lc. The reserved list in
`functions/lib/names.ts` is therefore a mail-interception control, not
cosmetic. RFC 2142 requires `postmaster` and `abuse` stay deliverable to us;
both are asserted separately so a tidy-up cannot drop them.

### Mail lands in a personal context and nowhere else

A shared context has no ingestion address. Not a disabled one, not one awaiting
configuration — mail cannot reach it. A note gets into a shared context only
when a person moves one there, so everything from outside passes through one
accountable owner's hands.

Inbound email is unauthenticated by nature: anyone who learns an address can
send to it, and the only thing between a stranger and a stored note is an
allow-list over a header the sender wrote. Writing into a space several people
read is a different risk from writing into your own. A shared address also
survives its members leaving and produces notes attributable to nobody, and the
sensible default allow-list — the address you signed up with — has no answer at
all for a shared context ("whose email?").

`resolvePersonalContextForIngestion` in `functions/lib/ingestionStore.ts` is the
single place that decides this. It requires the `kind: "personal"` chosen at
creation (no mutation ever changes it) *and* resolves the context's sole owner,
who is returned as the accountable person; a personal context with no
resolvable owner is damaged data and refuses. Every refusal is byte-identical
to the one an unclaimed name gets — a rejection that singled out the shared
case would publish which names here are teams.

**Sharing a personal context does not kill its capture address.** The rule
used to require exactly one *member*, so inviting somebody into your own
context silently bounced your mail from that moment on — and because every
refusal is identical, nobody was told. That was the cautious first guess, not
the intent, and the owner reversed it deliberately (2026-08): sharing your
context is a headline flow and must not cost capture. What holds the original
risk instead is that the policy stays owner-only in both directions — members
cannot read or change the allow-list (`functions/ingestion.ts`) — and every
capture is attributed to the sole owner. Re-tightening this to a member count
would re-break the flow somebody already decided to keep.

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
- **The consent screen defaults to `team` for everybody, owners included.** The
  old behaviour was private-by-default with no way out; a switch next to the old
  default would have changed nothing. Approving is opting in.

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

### One connection reaches every context its person belongs to

Asked for by the owner (2026-09-02) after somebody invited into a brain found
their agents could not open it: *"If I have access to someone's brain, my MCP
should be able to connect to it."* This **reverses** the section that stood here
a day earlier, which recorded the opposite as deliberate — that a grant covers
one context, and that widening it "is not a cleanup, it is a change to what a
consent means". That objection was right about what it costs and was overruled
with the cost stated, which is the only way it should ever have been settled.

`resolveGrantByAccessToken` returns every context its person is a **live
member** of, and `sessionForContext` in the gateway addresses one of them from a
tool call's `context: "@name"`. Read live rather than frozen at consent: a brain
shared with you afterwards is reachable from the client you already connected,
and one you are removed from stops being reachable on the very next call —
`resolveLiveGrant`'s rule 5, applied to the whole set.

**Reach is not permission, and only reach widened.** Every clamp that applied to
the connection's own context applies to the addressed one, from the grant's
scopes and the *target's* role: `effectiveScopes` makes a `member` read-only
wherever they are a member, and `visibilityTierForGrant` reads `team` for
anybody who is not that context's owner, so no private note of somebody else's
is reachable by any client, ever. What a connected client can do in your brain
is exactly what you can do in it yourself.

Five things hold it, and each fails a test if removed:

- **The clamp reads the grant's scopes, never the connection's clamped set.**
  `session.grantScopes` exists for this. Re-clamping an already-clamped set
  intersects two roles, so somebody who connected to a brain they are a `member`
  of would lose write in a context they *own* — fails closed, and reads as a
  permission bug in the wrong place. The fixture that catches it is a person
  whose home context is somebody else's brain.
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
decides anything name them: the connect-time `instructions` and `orient`. Both
list names and roles only — no bucket is opened to build either — because
surveying three contexts to answer a question about one is the cost that makes
orientation not worth calling.

### A grant is one person's tooling, and the refusal follows the listing

`listGrants` showed every grant in a context to `owner` and `editor` alike. The
argument for that was written about a *shared* context — "which robots can read
our notes" is a question the people responsible for the place need answered —
and then applied to every context there is. What it meant in a personal brain is
that somebody invited in to write notes opened Settings and found the owner's
nine connected clients sitting there: every AI tool that person uses, how much
of the context each one can read, and when it last read it. That is how it was
found, by the guest, who asked whether it was intended.

It is `owner`-only now, and the line is drawn there because it is
`revokeGrant`'s: an owner may cut off any client in their context, anybody may
unplug their own, and there are no other levers. An `editor` had neither, so
reading was the whole of their authority over rows they could never act on —
which is the sentence this codebase already used to withhold a `member`'s view
of somebody else's clients, and it is no less true a rung up.

**The refusal moved with it, and that is the half to re-derive rather than
preserve.** `revokeGrant` answered an editor `INSUFFICIENT_ROLE` and a member
`GRANT_NOT_FOUND`, on the stated ground that an editor could already enumerate
every grant and so learned nothing from being told which role they lacked.
Narrowing the listing turned that same sentence into an existence oracle: a
named refusal for a colleague's real grant and a not-found for an invented id
tells an editor which guessed ids are real. The rule — *the error may never tell
you something `listGrants` would have refused to tell you* — did not move; its
premise did, and a guard whose premise has been removed is worse than no guard,
because it still reads like one.

The console's half is smaller and is not disclosure: an owner of a shared
context is shown their colleagues' clients deliberately, but in a list headed
"Your endpoint", one card below a sentence promising that every client *you* add
appears below. Unmarked, a colleague's Claude is indistinguishable from one of
your own with a Revoke button beside it, so a row that is not yours says so —
from `isMine`, which the server already returned and the console dropped on the
floor, and never re-derived here from a user id. It does not name the person:
the row has to answer "is this mine", and who uses which AI client is more than
that question needs.

### An invitation is addressed to a string, and its token is stored in the clear

Two things about `functions/invitations.ts` look like oversights and are not.

**`inviteMember` never resolves the invitee.** It writes a row addressed to the
`@name` or the email, returns `null`, and finds out who that is only when
somebody accepts. Resolving up front — to store a `userId`, to answer "sent"
versus "no such person", to skip writing a row nobody can answer — turns the
invite box into a name-enumeration endpoint for the whole platform, because the
attacker in this threat model is the *inviter* and anybody with an account has
one. For the same reason `listInvitations` returns pending invitations and
nothing else: a decline, a withdrawal and an expiry must be the same absence, or
saying no tells the sender you exist. The one permitted asymmetry is that
inviting an existing member is a no-op — an owner can already enumerate their
own members.

**The token is not hashed**, which is the opposite of the rule `oauthGrants`
follows, and the difference is that this token is not a bearer credential:
accepting also requires being the addressed identity, so a dump of the table is
inert for anybody who is not already the invitee. Hashing would buy no
confidentiality and would cost the only delivery channel there is —
`listMyInvitations`, the invitee's own query — while nothing here sends email.

Ownership is not transferable. Every context has exactly one `owner`, written by
`createWorkspace`; `inviteMember` and `setMemberRole` both exclude `owner` in
their argument validators, and `removeMember` refuses to delete it. Adding
`owner` to either union would be an ownership transfer with no confirmation and
no way back. `@name` resolving to a person depends on that invariant — a handle
addresses the sole owner of the personal context it names.

### An invitation is delivered, and the delivery is scheduled rather than sent

`inviteMember` mails an `email` invitee a link. Three things about how are
load-bearing, and each undoes a different half of the section above.

**The send is scheduled, never called.** A `ctx.runAction` would hand the
inviter three answers to "does that mailbox exist": a return value, an exception
from Resend, and — needing no API at all — a latency difference between a call
that made an HTTPS round trip and one that did not. `ctx.scheduler.runAfter`
enqueues a job in a separate transaction whose return value is discarded, so
`inviteMember` still returns `null` and still takes the same time. That is what
makes it safe for the *scheduled* job to decide things the mutation never could,
including whether the address already belongs to somebody.

**A `@name` invitee is mailed nothing.** Not a deferred send: we have no
address, and finding one would be resolving an identifier to a person at invite
time, which is exactly what the invite box refuses to do. `listMyInvitations`
stays the channel for a handle and the fallback for every address, because mail
is dropped for an unverified inviter, dropped with no Resend key, sent at most
once per row, and may simply not arrive.

**The emailed link is not the invitation token being used as a credential.** The
token still only addresses the invitation; what signs a recipient in is a
separate `authVerificationCodes` row, minted through `auth:store` and stored as
`sha256(code)`. Making the token itself authenticate would invert the
unhashed-token decision in one step: a forwarded email would hand over an
account. No code is minted for an address whose account already has any
membership; auto-authentication serves the referral path, and the blast radius
of a standing credential in a stranger's empty account is not that of one in an
established member's.

**What bounds that code is single use, not a short clock.** It lives as long as
the invitation it travelled with — seven days — and dies on first claim:
`verifyCodeOnly` deletes the row before validating anything else, and answering
the invitation at all (accept, decline, or the owner revoking it) deletes it too.
So the window is seven days of *unclaimed* link, never seven days of usable
credential.

This was 24 hours, on the reasoning that a link is replayable and forwardable in
a way a typed code is not, so a week of it is a week of a live credential in
other people's archives. That risk is real and was overruled deliberately: at 24
hours the common case is somebody opening on Tuesday an invitation sent on
Sunday, and being asked for a code anyway. A link that expires before its
invitation does is a link that mostly expires, and an invitation that half-works
is the thing this flow exists to remove. Shortening it again without also
changing what "expires on first claim" means would be re-taking a decision
somebody already made with the trade in front of them.

`emailSentAt` is claimed in a transaction *before* the HTTP call, so one row is
one message. At-most-once over at-least-once deliberately: Context mailing the
same person four times because a job retried is indistinguishable, from their
side, from us being the abuse.

**That bounds duplicates and does not bound floods**, which is worth stating
because it read as a fence and was not one. `inviteMember` supersedes an
existing invitation and clears `emailSentAt` — on purpose, since re-inviting
somebody must not be a no-op in their inbox — so a re-invitation mails again,
and the only ceiling was `INVITE_LIMIT`, 20 per hour per account, on free
accounts. What rode on that gap is a subject line: a workspace display name is
80 characters the sender chooses, arriving from our domain with a real app
link beneath it.

So there is a second limit, keyed on the **recipient** rather than the row or
the sender, which is the only key that survives a second offer, a second
inviter, a second workspace and a second account. It is consumed inside the
scheduled action, and *last*, after every other refusal: enforcing it in
`inviteMember` would raise an error at an inviter whose presence depended on
other people's invitations to that address, which is a cross-tenant oracle, and
consuming it earlier would spend budget on mail that was never going to be
sent. The key is a hash of the address — footprint, not confidentiality, since
addresses are guessable.

**The link signs its recipient in, through a second provider, and that
separation is load-bearing.** `@convex-dev/auth`'s `Email()` hardcodes an
`authorize` that refuses any verification without a matching `params.email` —
right for a code typed off a screen, fatal for a link whose premise is that the
URL carries everything. `@supa-media/convex` registers a separate link-only
provider (`MAGIC_LINK_PROVIDER_ID`), which `auth.ts` opts into via `magicLink`.

Clearing the check on the OTP provider instead is one line shorter and would be
a serious regression: the rate-limit key in `verifyCodeAndSignIn` is derived
from `params.email`, so a verification with no email is not rate limited at
all, and the OTP secret is six digits. The separation holds at redemption
because the library resolves which `authorize` to run from the provider
recorded **on the row**, never from what the caller claims — and there is now a
test that redeems a real mailed code with no email and asserts a session, so
losing the override fails CI instead of silently making every link inert.

Sign-in codes for the link are minted by the app, not the library, so
`SIGNIN_CODE_TTL_MS` governs their life and `magicLink.maxAge` does not — see
"The sign-in link's life is `SIGNIN_CODE_TTL_MS`" below.

### There is no get-invitation-by-token query, and there must not be one

`acceptInvitation` throws one `INVITATION_NOT_FOUND` for never-issued,
not-yours, already-answered and expired. The invite screen keeps that collapse
structurally rather than by discipline: it looks its token up in the caller's
own `listMyInvitations`, so all four causes arrive as the same absence before
any copy is chosen. The obvious future improvement — a by-token query, for a
faster first paint — would reopen exactly the oracle `invitationNotFound()`
closes.

A failed subscription is the one permitted exception, with its own view. A query
error says nothing about the token, and telling somebody their emailed link is
spent when it is not is unrecoverable — the link is in an email they may never
open again.

### The sign-in link's life is `SIGNIN_CODE_TTL_MS`, and never `magicLink.maxAge`

`auth.ts` sets `magicLink: { maxAge: 60 * 60 }` while the link is good for the
invitation's seven days. Both are correct, and the obvious reading — that the
provider's `maxAge` is the link's expiry, so the two contradict each other — is
wrong. An earlier comment in `auth.ts` believed it, and "aligning" them is the
tidy-up to expect.

`@convex-dev/auth` reads `maxAge` in exactly one place, `signIn.js`, and only
where the **library** generates the code. Redemption checks the row instead
(`verifyCodeAndSignIn.js`: `verificationCode.expirationTime < Date.now()`).
`functions/invitationEmail.ts` mints its own code and passes its own
`expirationTime`, so `maxAge` never touches the invitation link at all.
Verified rather than argued: with `maxAge` set to **one second** the whole suite
still passes, including the seven-day expiry assertion. A test pins this.

What `maxAge` does bound is the one path that reaches this provider without
going through us. `api.auth.signIn` is public, so anybody can call
`signIn("magic-link", { email })` for an address they do not own. Nothing
reaches them — no `sendVerificationRequest` is configured, and a configured one
would mail the address that was named — but the code it mints is real, and this
is the provider with no email check and no rate limit. An hour is the shortest
useful life for it. **Setting it to seven days to "match" the invitation
lengthens only that code and buys the link nothing.**

### The two onboarding gates ask two different questions

They both used to count workspace memberships, and somebody invited into another
person's context broke that rule in both directions at once: before accepting
they had zero, so the `(app)` gate sent them to onboarding and they never saw
the invitation; the moment they accepted they had one, so the welcome gate sent
them to the console permanently, and they could never claim a name or own
anything. Being given a context locked them out of having one.

So the `(app)` gate asks whether there is anything here for you — a context you
can open, or an invitation you can answer — and the welcome gate asks whether
this flow has already run, which is a question about contexts you **own**.
Collapsing them back into one number restores both bugs. `standingFrom` returns
`undefined` unless *both* subscriptions have landed, because a standing built
from a resolved workspace list and an in-flight invitation list reads
`invitations: 0` — the exact shape of "send this person to onboarding".

### …and a third question nobody was asking: how do you get one?

The gates above are right and, on their own, left an invitee in a room with no
door. `needsOnboarding` renders rather than redirects for somebody who can
reach a context they do not own — correctly, since sending them to "claim your
name" throws away the invitation that brought them — and it says the prompt
"belongs on a banner rather than in a redirect". There was no banner.
`/welcome` was ready for them the whole time (`resolveWelcomeRoute` counts
contexts **owned**, so it renders at zero) and **nothing in the app linked to
it**. Being given a context was a one-way door out of ever having one.

So `offerOwnContext` is a third rule, and it is a different question again:
not "is there anything here for you" and not "has this flow already run", but
"is any of what is here *yours*". It answers from the console's own context
list, and the two ways it must fail are the ways its neighbours fail: never
while the list is loading (`undefined` is not "owns nothing", and a prompt that
flashes in front of a two-year user is the redirect bug wearing a banner), and
never for somebody who already owns one, because onboarding is not re-runnable
and the entry would lead to a screen that bounces them.

It is one accented entry, last in the rail's Contexts group. The group is where
it belongs because it answers the question that group raises — these are the
contexts you can open, and none of them is yours — and it is accented because
the person it is for arrived through somebody else's invitation and has no
reason to suspect the product does anything else. It is a callback rather than
a `ConsoleRoute`: `/welcome` is not under `/console`, and putting it in that
union would have `routeForPath` pretending to parse a URL it never sees.

### The hook is a capture-only OAuth client, and that is the whole design

An agent can call `save_context` when it finishes, and the failure mode is not
refusal — it is a long session that ends without one, where the thing worth
keeping was in the part nobody wrote down. The hook is the safety net, and
because it runs unattended it is the one credential in this system that sits on
somebody's laptop indefinitely.

So it asks for `context:capture` and nothing else. That grant writes to
`0-inbox/` and **cannot read a single note** — no search, no listing, no
existence oracle. The obvious upgrade, `context:write`, would let the hook
honour the user's own save destination instead of always landing in the inbox,
and it would also mean a stale credential on an old laptop can read every
private note its owner has ever written. That trade only goes one way, and a
capture landing in `0-inbox/` is not even a compromise: it is what that folder
is for.

It authenticates with the ordinary authorization-code flow over a loopback
redirect, which the gateway already supported — `redirectUriMatches` implements
the RFC 8252 §7.3 port exception precisely so native clients can do this. The
three alternatives were considered and are worse: a dashboard-minted long-lived
token is a bearer secret with no client identity behind it, so revoking it is
all-or-nothing; reusing the token the AI client already holds would require
reading another application's credential store; and token-in-URL is already the
compatibility fallback and never the boundary.

Each machine registers its own client, so revoking the laptop you lost does not
sign out the one on your desk.

**The capture boundary is an allow-list, and it is the most security-sensitive
code in the package.** A session log holds the system prompt, the model's
reasoning, every tool call and result, and the contents of files read along the
way. A message travels only if its role is `user` or `assistant` *and* its
content block is declared `type: "text"`. Switching on the declared type rather
than reaching for any `.text` present is what stops a `tool_result` — whose
nested blocks also have a `.text` — from being posted; the fishing version
passes every test written with plain string messages, which is why the suite
seeds a log carrying six distinct marker strings and asserts each one absent.

**The session-start hook is where the scope question actually bites.** Claude
Code injects a `SessionStart` hook's output into the session before the first
turn, which is the only mechanism anywhere in this product that does not depend
on an agent deciding something — and it is therefore the strongest available
answer to "connected agents never call `orient`". Fetching a real orientation
needs read access, on the credential that sits unattended on a laptop, so there
are two versions and the default is the narrow one: capture-only injects an
instruction to call `orient`, and `--orient` injects the orientation itself.

Three things hold that line. The wider mode is a flag somebody types, never a
default they discover afterwards. A change of scope **re-registers the client**
rather than re-authorizing the one that declared it wanted less. And neither
mode ever requests `context:private` — a hook that could read every note its
owner marked private is past what any convenience is worth, and the cost is
paid honestly: on a mostly-private context the injected orientation is thin and
says so.

Both hooks fail towards doing nothing loudly rather than something wrong
quietly. The start hook runs before the person has typed anything, so a revoked
grant, a slow gateway or a capture-only credential all come out as the
directive, and a capture-only install does not even spend the request finding
out it cannot read.

**A hook is only offered for a client whose contract can be read rather than
guessed** — and the first version of that list was wrong, in a way worth
recording because the error was not in the rule.

It said Claude Code was the only client with a documented end-of-session hook.
That was **asserted from memory and never checked**, and it is false: Codex CLI
and Gemini CLI both ship hook systems of the same shape — a command per
lifecycle event, `session_id`/`transcript_path`/`cwd` on stdin, and an
`additionalContext` field at session start. The claim shipped into a doc
comment, a README, a console string and this file before a question caught it.
Never state what another product does or does not support without looking; a
confident sentence about somebody else's software is the cheapest thing here to
get wrong and the most expensive to notice.

The rule itself survives intact, and still excludes two: **Cursor** has hooks
(`beforeSubmitPrompt` … `stop`) but publishes no transcript path, so the capture
half has nothing to read; **hosted ChatGPT** has no hook system at all. A hook
that silently never fires is worse than no button, because the person believes
their sessions are being saved and finds out months later that none were.

Three details differ between the three that are supported, and all three are
places to be careful: the file (`~/.claude/settings.json`, `~/.codex/hooks.json`,
`~/.gemini/settings.json`); what the end of a session is called (Codex says
`Stop`); and **the unit of `timeout` — seconds for Claude Code and Codex,
milliseconds for Gemini CLI**. The installer writes no timeout at all rather
than carry a number that means two different things depending on where it lands.

It also writes **no property outside the client's own schema.** An earlier
version stamped a marker key onto its hook entry to recognise it later; that is
an unknown field inside somebody else's config, across three parsers whose
strictness we cannot test, and the cost of being wrong is their whole settings
file failing to load. Our entries are identified by the command string instead —
still recognised on read, so an upgrade replaces an old marked entry rather than
stacking a second one beside it.
