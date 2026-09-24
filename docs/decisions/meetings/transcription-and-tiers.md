# Meetings — transcription and tiers

### The cloud path knows *who* is asking, opaquely, and the ceiling is the control plane's

The cloud tier spends real money per request, and for a while nothing bounded
it. `transcribeChunk` checked `getAuthUserId` and nothing else — deliberately,
since the audio never becomes anything the control plane owns and there is no
workspace to authorize against — but sign-up is open email OTP with no invite
gate, so "a signed-in account" is a barrier of approximately zero. Each call
carries up to 8 MiB of audio. And the body posted to the Worker was
`{ audioBase64, mimeType, durationMs }`: no caller at all, so a surprising bill
had nothing in it to trace.

Two things follow, and they are the enforceable part.

**The ceiling lives in the control plane, and this reverses what this section
used to say.** It said the limit was the Worker's, using Cloudflare's native
rate limiting binding, and that the control plane could not host it without
changing what `functions/meetings/transcribe.ts` is. Both halves of that need
correcting, and the order matters:

*The Worker's binding does not enforce on this account.* Measured against the
deployed Worker, twice: 45 requests on one key in two seconds drew zero 429s,
and 30 paced a second apart — inside the 60s window, slow enough for the
documented eventual consistency to settle — drew zero 429s. Re-run on a second
`namespace_id` after Cloudflare's docs turned out to require "a positive
integer, unique per account" rather than the arbitrary string the config
comment claimed: same result. The binding was provably attached to the live
script and printed by `wrangler deploy --dry-run`, the call site is
unconditional and fails closed. The Worker's unit tests exercise a fake limiter
and stayed green through the whole failure, which is
[testing](../testing.md)'s one rule arriving as a bill rather than as a
principle.

*So the ceiling moved here, and the price was named before it was paid.*
`transcribeChunk` now holds one `ctx.runMutation`, to one `internalMutation`,
which calls `consumeRateLimit` and writes one `rateLimits` row. **Twenty chunks
per account per minute**, against a workload of three a minute per live
recording (`SEGMENT_MS` is 20s) and six for somebody recording the same meeting
on two devices — the same ceiling the Worker declares, kept identical so there
are not two numbers to reconcile. It is consumed **after** authentication, so an
anonymous caller cannot spend somebody else's allowance or learn from the shape
of a refusal that an account exists, and **before** everything else — argument
validation, the environment reads, the fetch — so a refused caller costs zero
inference. The refusal is a `ConvexError` with code `RATE_LIMITED` and a
`retryAfterMs`, distinct from `TRANSCRIPTION_FAILED`, because a client that
could not tell them apart would retry straight back into the limit while
reporting a broken worker.

**What was given up, stated exactly.** That action held no `ctx.db`, no
`ctx.storage`, no `ctx.scheduler` and no `ctx.runMutation`, so it was
*structurally* unable to persist a transcript — a stronger claim than "it does
not", because it did not depend on anybody reading the code. That is no longer
true of the handle. Three narrowings replace it, and each is a check rather than
a sentence:

- The mutation is `internalMutation`, so no client can reach it. The check is
  `the budget mutation is internal, not public`.
- Its argument validator is `{ userId: v.id("users") }` and the test asserts
  that key set **exactly**, so there is no field audio, base64, a transcript, a
  chunk id or an offset could travel in, and one cannot be added silently. The
  check is `the budget mutation cannot be handed content`.
- The table sweep that said *no table is written* now says **`rateLimits` is the
  only table written**, pinned to a single row, with every other table in the
  schema still counted and still asserted untouched. That is stronger than the
  old assertion everywhere except the one point the owner chose to give up: the
  old one could not tell a first write from a second, so relaxing it to admit
  the counter would have left nothing to say about the row after it. The checks
  are `only \`rateLimits\` is written, and nothing is scheduled or stored` and
  `no row written anywhere carries the audio or the transcript`.

The Worker's binding is **not removed**, and neither is the header it keys on.
`checkRateLimit` fails closed on an absent binding, so deleting the declaration
would refuse every request — worse than a limit that does nothing. Treat it as
absent until somebody watches it return a 429. The remaining checks there are
unchanged and still worth having, because they describe the shape a limiter
must have wherever it lives: `refuses before the body is read, not after`,
`an unauthenticated caller never touches anybody's bucket`,
`a limiter that throws refuses, it does not wave the caller through` and
`a binding removed from wrangler.jsonc refuses too`. The control-plane checks
are `the call after the limit is refused, and buys no inference`,
`one account's spending does not touch another's`,
`the budget is per window, so a long meeting keeps transcribing`,
`an anonymous caller spends nobody's budget, and writes nothing`,
`an over-budget caller is told about the budget, not about their chunk id` and
`the ceiling is the one the comment argues for, and the Worker's own`.

**The identifier is an HMAC of the user id under the shared worker secret, and
never the user id.** This half was never the broken one and is unchanged. It
travels in the `X-Caller-Hash` header — a header, not a body field, precisely so
the Worker can refuse before parsing the audio. Three properties are being
bought at once, and no simpler construction buys all three: it is *stable*, so
it can key a limit at all (anything per-request is a fresh bucket per request,
which is no limit); it is *opaque*, so the Worker, its logs, and anyone who
intercepts the header hold no account identifier — a plain SHA-256 would not do,
because with no secret in the construction anybody holding a user id can confirm
a guess against it; and it is *recomputable by the control plane*, which holds
both the secret and the users table, so the account behind a bill can actually
be named. That last one is the reason it is an HMAC rather than a random
per-user token: a token would need a stored mapping, which is a row this action
must not write.

Metering and tracing are not the same thing and both are wanted. The ceiling
above stops a runaway caller; the identifier is what puts a name on the spend
that did happen, on served requests as well as refused ones. An unbounded spend
that names nobody is not a stronger privacy position — it is the same disclosure
with a bill attached — and a bounded spend that names nobody still leaves an
operator with a number and no account.

The inversion is a linear scan over `users`, spelled out on `callerHash` in
`functions/meetings/transcribe.ts`, and it is checked rather than merely
described — the test recomputes it with `node:crypto` independently of the
implementation. **Rotating `TRANSCRIBE_WORKER_SECRET` makes every previously
logged identifier permanently un-attributable.** That is a real cost of rotation
and is written down here so it is a decision somebody takes rather than a
surprise somebody discovers. The checks are
`sends an opaque caller identifier the worker can key a limit by`,
`never sends the user id, in the header, the body, or the URL`,
`is the same for the same account on every call`,
`is different for a different account` and
`is keyed by the worker secret, so it is not derivable without it`.

This is a real, deliberate widening of what the Worker is told. *Nothing joins
the call* and the Worker's own header both say it holds no session, no
workspace, no context id and no position in a recording, and all of that stays
true: it now learns that two chunks came from the same caller, and nothing else
about who that is.

**Three things this does not cover, stated rather than glossed.** The limit is
per *account*, so somebody willing to open many accounts gets many buckets: that
is a signup-gate problem — open email OTP with no invite — and it is not this
seam's to solve. The window is fixed rather than sliding, so a caller can spend
one window's budget at its end and the next window's at its start: the true
worst-case burst is 40 chunks in a short span, which `lib/rateLimit.ts` says
outright and which does not matter at this size. And nothing here meters
*spend*: this caps requests, not dollars, and a budget that stops at a number of
dollars does not exist and is not pretended to.

### The desktop is an OAuth client of the gateway, and it asks for the tier its meetings are filed at

The phone writes a meeting the way it writes a note, through the control plane,
because that is the credential it holds — `apps/mobile/features/meetings/convexGateway.ts`
argues that at length and it has not changed. The desktop app holds the other
kind, and the reason is not symmetry:

**A laptop app that could read every context its owner belongs to is a much
larger thing to lose than one holding a revocable grant on one.** A
control-plane session reaches every workspace a person is a member of; a grant
is minted per machine, appears in the console beside the AI clients, and is
revoked on its own. So the desktop registers itself as its own OAuth client
through the same reviewed flow `plugins/context` ships — RFC 9728 discovery,
dynamic registration, a loopback redirect on `127.0.0.1`, PKCE with S256, a
constant-time state comparison, and a refusal to walk to any URL that is not
https or loopback. It imports that module rather than copying it, because a
second PKCE implementation is a second chance to get the state comparison wrong.

**The scope is `context:write context:private`, and the second half is not
decoration.** `visibilityTierForGrant` reads a grant without `context:private`
as `team`, and `publishMeetingNote` files a meeting at the connection's own
tier — so a recorder that asked for the narrower thing would file every meeting
its owner recorded as team-visible. That is a privacy default nobody chose,
arrived at by asking for less, and it is exactly the shape of mistake this
section exists to stop somebody making again as a "tightening". It does not ask
for `context:read`: this app never reads the context, and a laptop credential
that could read every note its owner ever wrote is past what the feature is
worth.

**The credential is in the OS keychain and the renderer cannot reach it.**
`safeStorage` over a 0600 file created at open time, written atomically; a
machine whose OS offers no encrypted storage holds it for that launch only and
says so on the panel, rather than writing a bearer token to disk in the clear.
Those rules live in `core/sync/encryptedFileStore.ts` rather than beside the
Electron import, for the same reason `connect.ts` moved its: they were prose in
a header no suite could load. `test/tokenStore.test.mjs` drives them against a
fake keychain and a real directory — `THE PLAINTEXT TOKEN IS NOT ON DISK`,
`THE FILE IS 0600`, `NO KEYRING MEANS NO FILE AT ALL` and
`A FILE THIS KEYCHAIN CANNOT OPEN READS AS 'NOT CONNECTED', NOT AS A CRASH`.
`main/tokenStore.ts` is now the one line that names `safeStorage`.
No preload channel reads it, and the base URL requests go to is stored *with*
the credential, so a token cannot be posted to a gateway other than the one it
was minted for.

A "simplification" here has three tempting shapes and each costs something
specific: dropping `context:private` silently changes what every meeting is
filed as; falling back to a plaintext file on a machine with no keyring breaks
*credentials never live on a device*; and reusing a token another application
holds is the design this repository has already refused. The checks are
`test/connection.test.mjs`'s whole file — in particular
`three callers racing an expired token refresh ONCE`,
`A CAPTIVE PORTAL IS NOT A REVOCATION` and
`...BY THE TIME THE TOKEN WAS HANDED OUT, so a crash cannot spend a token nobody saved`.

**And the acquisition half is checked too, which took moving one import.**
`main/connect.ts` held a top-level `import { shell } from "electron"`, so no
suite on plain Node could load it and sabotaging its state comparison failed
nothing anywhere in this repository — an auth path with no check behind it,
which is the one thing CLAUDE.md names outright. The Electron call is a dynamic
import inside the default browser opener now, for the reason `main/transcribe.ts`
already gave for holding none, and `test/connect.test.mjs` drives the real flow
against a real `127.0.0.1` listener: `A CALLBACK CARRYING THE WRONG STATE IS
REFUSED`, `...AND THE CODE IS NEVER EXCHANGED, so an injected code buys no
grant`, `THE SCOPE ASKED FOR IS WRITE AND PRIVATE`, `A PLAINTEXT GATEWAY IS
REFUSED` and `THE LISTENER ANSWERS ONCE AND CLOSES`. Putting the static import
back is not a tidy-up; it deletes those five checks.

### A recorder that holds a grant transcribes at the gateway, and the meeting's own record is the ceiling

The section above settles the cloud path for a client with a *control-plane*
session. `POST /meetings/sessions/:id/transcribe` is the same question answered
for a client with a **grant**, which the control plane's own file said was open
and warned against answering sideways — minting a grant-shaped credential over
there would have been answering it in the one place where getting it wrong is a
token on a device.

Everything about it is the same promise: audio exists for the life of one
request, is forwarded to the same `context-transcribe` Worker, and is never
written, cached, queued or logged. The gateway is handed a forwarder built from
the environment, so the module that touches audio reads no secret, and the
service is told the audio, its container and its length — never the session, the
chunk id, the offset or the workspace.

**The ceiling is the interesting part, because this Worker has no database.**
The gateway is stateless by construction and that property is worth more than
this feature, so the count lives where the request is already going: in the
meeting's own session record, in the customer's own bucket, under the same
conditional write as every other change to a session. Three bounds follow, and
each is a bound rather than a hope:

- a chunk must belong to a session that **exists in the caller's own context**
  and is not complete, so inference cannot be bought by somebody who is not
  recording anything;
- a session has a chunk budget, consumed **before** the audio is forwarded, so a
  refused caller costs zero inference — the same ordering the control plane's
  limit uses, for the same reason;
- spend is attributable through an HMAC of the workspace id under the shared
  secret, never the id.

Two costs, named rather than discovered. A chunk whose transcription *fails*
still spent its budget — the right direction, since the alternative is spending
inference for free by making it fail — and the budget is per session rather than
per account, so it bounds a client in a loop rather than somebody who opens many
meetings. The second is the same signup-gate problem the control-plane limit
has, and it is not this seam's to solve either.

**A third cost, and it is the one a reader will otherwise assume away: this
count is not tamper-evident, and on customer-owned storage it cannot be.** The
record lives in a bucket whose owner holds the credential by construction —
non-negotiable #1 — so the person being metered can open `.meetings/<id>.json`
in Obsidian and set `transcribedChunks` back to zero. Nothing in the gateway
can stop that and nothing should try; a counter we could keep out of their
reach would be a counter kept somewhere we promised not to keep anything.

What that does and does not mean, precisely. It is **not** a tenant-isolation
bound and none of the three above weaken: the session must exist in the
*caller's own* context (`a neighbour holding the id cannot transcribe into it`),
the counter survives every fold the gateway itself performs — `applyEvent`
spreads the record, so an upsert or a segment batch carries it, which
`THE BUDGET SURVIVES AN EVENT FOLD` pins — and spend stays attributable through
the HMAC whatever the count says. What it is is a **billing** bound that an
account holder can lift on their own account, and the honest statement is that
on this path there is then nothing under it: the transcribe Worker's own
limiter is measured-absent (see `infra/transcribe-worker/src/rateLimit.ts`, and
the section above), and `consumeTranscribeBudget` guards the *control plane's*
route, not this one. Same standard as that section: treat this as attribution
plus a bound on a client in a loop, not as a spend cap. A real cap for a
grant-holding recorder needs a counter somewhere we own, which is a control-plane
round trip per chunk and a decision nobody has taken.

**An unconfigured deployment answers 501, not 503.** Every self-hosted install
is unconfigured, and a client that read the refusal as temporary would ask again
every twenty seconds for the length of a meeting; 501 is what turns that into
one honest sentence and a typed meeting. A URL with no secret would post meeting
audio to an endpoint unauthenticated, so the pair is both-or-neither at the
deploy as well as in the code.

Reversing any of it costs: without the session anchor there is no ceiling at all
on a stateless Worker, and the checks that fail are
`a neighbour holding the id cannot transcribe into it` with
`...AND BUYS NO INFERENCE DOING SO`,
`a meeting that has spent its budget is refused, and not with a retry code` with
`...COSTING ZERO INFERENCE`, and
`a gateway with no transcription configured refuses, permanently`.
