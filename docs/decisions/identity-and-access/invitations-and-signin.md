# Identity and access — invitations and sign-in

### A grant is one person's tooling, and the refusal follows the listing

`listGrants` showed every grant in a context to `owner` and `editor` alike. The
argument for that was written about a *shared* context — "which robots can read
our notes" is a question the people responsible for the place need answered —
and then applied to every context there is. What it meant in a personal workspace is
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
