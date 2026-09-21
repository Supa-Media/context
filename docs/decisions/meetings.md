# Meetings

_See `docs/decisions/README.md` for the index._

Context records meetings. Not as a separate product with its own account, its own
storage and its own export button, but as a capture surface for the thing this
repository already is: **a meeting becomes plain Markdown in a bucket the
customer owns, and every AI client they have already connected can read it
through the same endpoint, with nothing to integrate.** That sentence is the
entire reason this lives here and not in a new repository. A meeting recorder
that held your meetings would be a competitor to us as much as to anyone else.

The contract every surface agrees to is `packages/meetings/src/protocol.js`.
It is the single source of truth for what a meeting *is*: the session shape, the
state machine, the events, the gateway routes, the detection inputs and the
watch's five verbs. The decisions below are the arguments behind it. Changing
one of them means changing that file, which means changing every client at once
— which is the point of having it.

### One file per meeting, and `read_meeting` is what that costs

A finished meeting is **one note**. The generated summary, the human's own
notes, and the transcript are three headings in one file — `## Summary`,
`## My notes`, `## Transcript` — not two files with a link between them.

The alternative was a sibling `*.transcript.md` with a frontmatter pointer, and
it is genuinely tempting: it keeps the note small, and the expensive half is
only fetched when someone asks for it. It was rejected because a note and its
transcript are one thing to a human and to every tool that is not ours. Two
files means Obsidian shows two entries, search returns both for one query,
moving the note to `1-projects/` orphans the transcript, archiving one archives
half a meeting, and `4-archive/` slowly fills with transcripts whose notes moved
away. Every one of those is a bug report the customer files against *Obsidian*,
because that is where they saw it. The bucket is the vault
([plugins](./plugins.md)), and a file that only makes sense
to the program that wrote it is exactly what plain-file portability is supposed
to rule out.

**The cost is real and is not hidden here: `read_note` returns whole files.** A
forty-minute transcript is tens of kilobytes, and an agent that opens a meeting
to answer "what did we decide" should not spend a third of its window on
crosstalk. So the mitigation is at the tool boundary rather than in the file
layout:

- **`read_meeting` omits the transcript by default** and returns the frontmatter,
  the summary and the human's notes. It takes `transcript: true` to include it,
  and says in its result that there is one and roughly how big it is, so an
  agent can decide rather than guess.
- **`read_note` on the same path still returns the whole file**, unchanged and
  ungated. `read_meeting` is a convenience over one file, never a second
  visibility rule; a path an agent may not read is refused identically by both.

Reversing the split — making `read_meeting` return everything because "it is
simpler" — puts a transcript into the context of every client that opens a
meeting for any reason. The checks are
`read_meeting omits the transcript unless it is asked for`,
`read_meeting names the transcript it withheld`, and
`read_meeting and read_note refuse the same paths`.

### A meeting note is a note, and `privacy.md` decides it with no bypass

There is no meetings visibility model. A meeting note sits in a folder, the
folder's rule in `privacy.md` applies to it, an exact-note override beats the
folder rule, and `canSee` decides. `list_meetings` is a listing filtered by the
same engine as any other listing, and it is derived from the notes rather than
from a table the gateway keeps — a meeting the caller may not read is not
listed, not counted, and not implied by a gap in a count
([privacy-and-sharing](./privacy-and-sharing.md)).

This is worth stating because a meetings feature is where a bypass would arrive
looking reasonable. The desktop app wants a fast recent-meetings list; the
console wants counts; the mobile app wants a badge. Each is a reason to keep a
meetings index somewhere convenient and read it without going through `canSee`,
and the first one that ships that way makes the privacy engine advisory.

The rule that keeps it honest: **the gateway never learns about a meeting from
anywhere but the bucket.** Session metadata in flight is in-flight state
(see [architecture](../meetings/architecture.md)); a *finished* meeting is a
file, and files are read through the privacy engine, full stop.

The checks are `a private meeting is invisible to a team grant` and
`list_meetings surfaces nothing read_note would refuse`, and the second one is
sabotage-tested: make `list_meetings` read a cached list instead and it must
fail.

### Nothing joins the call

The desktop app captures the system audio the machine is already playing and the
microphone it is already using. It does not authenticate to Zoom, Meet, Teams or
anything else, does not send a participant, and does not appear in the attendee
list. Six people in the meeting see six people.

The bot approach buys things this one cannot have: it records meetings you did
not attend, it survives your laptop going to sleep, and it gets a clean
per-speaker feed from the platform, which is most of why bot-based products have
better diarization than we will. Those are real losses and this document is not
going to pretend otherwise.

What it buys instead is the whole security story. A bot is a third party holding
credentials to the customer's conferencing account, sitting in rooms it was
invited to by an automation rather than by a person, and recording on the
platform's servers before anything of ours touches it. That is a second data
plane, owned by us, in a product whose first non-negotiable is that we do not
hold the customer's data. It is also an integration per platform, each of which
can be revoked by an administrator who never agreed to it.

The check is `no code path authenticates to a conferencing platform`, and it is
a grep-shaped guard with the usual weakness — see
[testing](./testing.md), *a guard nobody has checked is not a guard* — so it is
written against outbound host allowlisting rather than against import names.

### A browser records the whole call only if somebody hands it the call

Reported by the owner, on the web build: *"when I have headphones on, it does
not record what I'm hearing through my headphones."* Correct, and it was
documented as correct — `capture/audio.web.ts` said in its own header that
system audio was the desktop app's job, and the sheet said in as many words that
the far side of a call on headphones is not in the recording. Honest, and still
the wrong answer to somebody on a call in a browser, which is most people.

**A browser cannot tap the machine's output, and that has not changed.** There
is no `getUserMedia`-shaped route to the speakers, and there never will be: a
page that could silently record everything a machine plays is a page that can
record every other tab. What a browser *can* do is `getDisplayMedia` — put the
platform's own picker in front of the person, take the tab or screen they
choose, and record the audio of that source if they tick the option offering it.
Mixed with the microphone through a `MediaStreamAudioDestinationNode`, that is
both sides of a call in one recording, chosen by the person, once per meeting,
with the browser's own sharing indicator lit the whole time.

**So `capability.systemAudio` now means two mechanisms, and the sheet may never
say them in the same words.** The shell's is a loopback tap: the switch is on,
the machine's output is in the recording, nothing is asked again. The browser's
costs a picker, every meeting, with a checkbox most people have never noticed on
it. `systemAudioNeedsPicker` is the second field that keeps them apart, and it
carries three consequences that are the whole of this decision:

- **The offer is off by default in a browser and on in the shell.** A default of
  on would put a screen-share picker in front of every meeting anybody records,
  including the in-person ones. That is not a feature people turn off; it is a
  feature people stop using.
- **A caller who says nothing gets what the build can do *without asking
  again*.** `controller.start`'s fallback used to be the capability itself,
  which was right while the only mechanism was silent. Left that way, any code
  path that starts a meeting without going through the sheet would open a picker
  on behalf of somebody who was never asked.
- **The picker is opened before the microphone prompt, and that order is not a
  preference.** `getDisplayMedia` requires transient activation and
  `getUserMedia` does not, so a microphone prompt sitting on screen while
  somebody finds Allow spends the activation the picker needs — and the share
  would then be refused for a reason that has nothing to do with what anybody
  chose.

**Three ways the ask comes back empty, and they are the ordinary case rather
than the edge one.** The picker is cancelled; the source chosen carries no audio
(a whole screen on most platforms, anything at all on a browser that shares no
audio); or nothing on the page can mix two inputs into one recording. All three
leave a microphone recording, all three say one sentence, and the share is
handed straight back rather than held — a captured tab with its indicator lit,
contributing nothing to the transcript, is the worst available outcome. Pressing
the browser's own "Stop sharing" mid-meeting is a fourth, and it says so too:
what was recorded before it has both sides and what comes after does not.

**What is claimed is *"this browser can ask"*, which is true, and no more.**
There is no API that says in advance whether a browser will hand over audio —
Firefox has `getDisplayMedia` and shares none from it — so the capability probe
checks the two things that *are* knowable (a picker exists, and there is
something to mix its audio into) and every empty answer is reported in a
sentence. That is the same rule as everywhere else here: an absent capability is
reported, never faked.

**Nothing about *nothing joins the call* moves.** This records a source the
person handed over on the machine they are sitting at. It authenticates to no
platform, sends no participant, and appears in no attendee list.

The checks are `both halves of the probe, or no offer at all`, `the picker is
opened before the microphone prompt`, `nobody is asked to share anything unless
they asked for it`, `a shared source is mixed with the microphone, and the mix
is what records`, `the call's audio is never played back into the room`, the two
`a microphone recording, and a sentence saying so` rows, `a source with no audio
is let go rather than held`, `a share stopped mid-meeting is said out loud, and
the rest is recorded`, `ending a meeting turns the sharing indicator off as well
as the recording one`, `a refused microphone hands the share back rather than
leaving it running`, `a browser says a picker is coming, and what to pick`, and
`a picker is not opened on somebody's behalf`.

**Not proven here:** that a real Chrome hands back a real tab's audio and that
the mix is intelligible. The suite drives a fake browser; the last step needs a
machine, a call and a pair of headphones.

### iOS recording survives screen lock through two deliberate controls

The recorder has two controls: the shipped native configuration declares
`UIBackgroundModes: ["audio"]`, and the OTA-delivered meeting audio mode opts
the active recorder in with `allowsBackgroundRecording: true`. Both are needed;
the runtime switch alone cannot add a native entitlement, while the entitlement
alone does not opt a session in. This covers ordinary screen lock and app
backgrounding, not force-quit or OS process termination. Acceptance is a real
iPhone lock/unlock test confirming the transcript continues without a gap.

Some shipped iOS runtimes reject the background-capable audio-mode object even
though they can still record with the prior foreground mode. The recorder tries
the background mode first, then restores foreground capture if that request is
rejected and immediately tells the person that locking the phone will stop
audio. That limitation has its own sticky, multiline notice on the live screen;
transcription notices must not overwrite it. It must never turn an optional
background upgrade into a total recording failure, and it must never make that
downgrade silently.

### Transcription is cloud on the paid tier and on-device on the free tier, and that seam is disclosed, not glossed

This is the one place where "we never hold your data" needs a footnote, and the
footnote belongs in the product, not only here.

- **Free tier: on-device.** Apple's `SpeechAnalyzer` / `SpeechTranscriber` on
  iOS 26 and macOS 26, WhisperKit elsewhere. Audio never leaves the machine;
  only text is written, and it is written to the customer's own bucket.
- **Paid tier: cloud.** Better punctuation, better handling of distant
  microphones, and diarization that on-device transcription does not provide at
  all. Audio is streamed to a transcription service, is transient there, and is
  never stored by us — but it *does* leave the device, and for the length of the
  request it is in a third party's memory.

The honest statement of the seam, which the marketing copy is not allowed to
soften: **on the paid tier, your meeting audio is processed by a service that is
not you and not us.** What remains true on both tiers is the part that actually
distinguishes this product — the *notes* land in storage you own, we hold no
copy, and revoking our credential leaves you with everything.

Four rules follow, and they are the enforceable part:

1. **Audio is never written to the bucket and never persisted by us.** Not as an
   attachment, not as a cache, not "temporarily" in a queue that has no expiry.
   The note is the artifact; the recording is not. The check is
   `no ingestion path writes an audio content type`.

   **Amended 2026-09-18, and narrowed rather than dropped.** "Us" is the
   control plane, the gateway, the transcription Worker and the customer's
   bucket, and on every one of them this rule stands exactly as written. What
   changed is the customer's *own phone*: audio that has not reached the
   transcriber yet is now kept there, in a queue with no expiry, until it has.
   That is the owner's call and the argument is *Audio nobody has transcribed
   yet is kept on the device* below; the sentence above is left as it was
   because it was right about everything it was about.
2. **Every note records how it was made.** `transcription: on-device` or
   `transcription: cloud` in the frontmatter, alongside the device that recorded
   it. A person reading a meeting from eight months ago can tell whether its
   audio ever left their laptop, which is not a question they should have to
   reconstruct from their billing history. The check is
   `a finalized note names the engine that produced it`.

   Four things that follow, because each is a way of writing this key that
   would not keep the promise. **The key is always written**, and a meeting
   nothing transcribed says `transcription: none` — an absent key and an old
   note are the same thing to a reader, so omitting it on the notes-only case
   is the one shape that answers nobody. **`null` is the third legal value and
   is explicit** on `MeetingSession`, never an absent field:
   `TRANSCRIPTION_ENGINES` names the two engines, and "no engine" is the
   absence of a member rather than a member of the list. **An engine nobody
   recognises is refused rather than coerced** — `source.kind` falls back to
   `unknown` and `device.platform` to `web` because those are a detector's
   evidence, while this field has no honest fallback: `null` would claim
   nothing was transcribed and `cloud` would claim something left the machine.
   And **a session's engine is set when it opens and is never rewritten**: it
   may be raised from `none` to an engine, but audio that has been streamed to
   a service cannot un-leave the machine, so a client talking a note out of
   saying `cloud` is refused. `device:` beside it is `name (platform)` when the
   device named itself and the bare platform when it did not — the platform is
   the floor, the name answers "which of my two Macs", and the app version is
   not a device.
3. **The choice is visible before the recording, not in a settings page.** A tier
   that silently upgrades the transcription path is a tier that silently changes
   where the audio goes.
4. **The cloud path is `https`, and a deployment that says otherwise is refused
   rather than obeyed.** The transcription Worker's address is an environment
   variable, so an `http://` typed into it is the one misconfiguration here that
   is both silent and severe: every chunk of every meeting on that deployment
   crosses the public internet in the clear, and nothing complains. We are
   willing to say out loud that the audio is processed by somebody who is not
   you and not us; we are not willing to say it was readable on the way there.
   The single exception is **loopback**, because `wrangler dev` serves plaintext
   on `127.0.0.1` and self-hosting the whole stack locally is a supported path —
   and loopback reaches no network, so there is nothing on it to intercept. It
   is matched on the parsed hostname, never as a substring, because
   `127.0.0.1.attacker.invalid` is an ordinary public name. The checks are
   `an http:// worker is refused, and the audio never leaves`,
   `http on loopback is allowed, because `wrangler dev` is one`, and
   `http on a host that merely looks like loopback is refused`.

Collapsing the two tiers to one cloud engine would be simpler, cheaper to
operate and better at diarization, and it would delete the free tier's actual
claim. Collapsing to on-device only would delete diarization and lock the
product to recent Apple hardware — `SpeechAnalyzer` is iOS/macOS 26 and later,
and on watchOS it does not exist at all.

### The channel is the only speaker signal this product has, and a turn never crosses it

The section above promises that the paid tier buys "diarization that on-device
transcription does not provide at all". **As shipped it does not, and this is
the entry that says so rather than leaving the promise standing.** The
transcription Worker runs `@cf/openai/whisper-large-v3-turbo` with
`@cf/openai/whisper` behind it; neither returns a speaker label, so
`apps/mcp/src/meetings/transcribe.js` sets `speaker: null` on every segment and
explains why in its own comment — *a "Speaker 1" it did not produce is a label
with more confidence than it earned*. That comment is right. The promise was
ahead of the code, and what follows is what is true.

**What there is instead is `channel`.** The recorder stamps every frame `mic`,
`system` or `mixed`, because the engine is handed one file and "cannot know
whether it was the room or the call". That is one real bit of knowledge about
who was speaking, and `groupIntoTurns` used to throw it away: with `speaker`
null on both sides, a two-sided call folded into one turn and rendered as
`**[00:00] Speaker** — so the pricing is fine with us`, half of it said by
somebody else. **A channel change now breaks a turn.** The check is `the
microphone and the call never merge into one turn`, and the sabotage record is
in the test file: removing the condition fails two checks in `packages/meetings`
and none in `apps/mcp`, because the gateway never looks at a turn.

**What is deliberately not decided here is what a turn is called.** The obvious
move — mic is "You", system is "Them" — is wrong in the case this product was
built for: in an in-person meeting everybody is on the microphone, and labelling
the room "You" is a false attribution written into somebody's permanent note. A
label needs evidence that the session was two-sided, which is a session-level
fact the renderer does not hold today. (`capture/transcriber.ts`'s
`speaker: frame.channel === "mic" ? "You" : null` is a test engine's fixture,
not a precedent.) Turns split honestly and stay labelled `Speaker` until that is
decided.

Three routes out, and the third is the one people assume:

1. **Channel labels, conditioned on a session that really had two sides.**
   Cheap, no new vendor, no new audio path. It buys "me" against "the call" and
   never buys "Sayo" against "John".
2. **A diarizing engine on the paid tier.** It buys real speaker turns, and it
   costs a second vendor holding audio transiently — widening the seam the
   section above discloses — plus per-hour inference against Workers AI's
   account-level pricing. The part that decides it is not the bill:
   **speaker identity does not survive `SEGMENT_MS`.** Chunks are twenty seconds
   and are transcribed independently, so whoever is "Speaker 1" in chunk three
   is not knowably "Speaker 1" in chunk four. This is therefore not a model swap
   inside `infra/transcribe-worker`; it is a per-meeting streaming session
   against a provider that keeps speaker state, in a Worker that is stateless by
   construction. Price that, not the model.
3. **One pass over the whole recording when the meeting ends**, which is where
   the best accuracy is. **Rule 1 above forecloses it**: whole-file diarization
   needs the whole file, and audio is never persisted by us. The device queue in
   *Audio nobody has transcribed yet is kept on the device* is not a way round
   it — that is the customer's own machine holding audio that has **not been
   transcribed yet**, not a meeting's worth held back so we can read it twice.
   Taking this route means amending rule 1 with an argument, not a footnote.

Recommended: 1 now, 2 when somebody is paying for it, 3 not without reopening
rule 1. Matching a voice to a *named person* is a further step again — it needs
an enrolled voice per contact, which is biometric data this product has nowhere
to put and no non-negotiable that would survive putting it there.

What a "simplification" of this costs: drop the channel break and the far side
of every call goes back inside a block attributed to whoever spoke first, which
is worse than no attribution because it reads like evidence.

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
[testing](./testing.md)'s one rule arriving as a bill rather than as a
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
through the same reviewed flow `packages/hook` ships — RFC 9728 discovery,
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

### Pressing Record is the same yes, and the blocklist sees less of it

Detection cannot see two people at a table: an in-person conversation is not a
process, a window title or a calendar event. So the desktop offers *Record a
meeting*, and it mints its own consent episode — pressing it is the same
sentence the panel asks for, given first rather than in answer.

One consequence is uncomfortable and is written here rather than left to be
discovered. **The blocklist can only refuse what the detector is currently
reporting.** Blocked apps are stripped out of the signals before `detect()` sees
them — that is the stronger half of the promise, and it is why a blocked app
never becomes a source, a tooltip, an evidence line or a log entry — so on the
manual path there is nothing to match against. Press Record during a call in a
blocked app and the recording starts.

That is the trade rather than a gap to close later: the blocklist means *never
record this app for me, automatically*, and it cannot also mean *refuse an
instruction I gave with the app in front of me* without watching the app it
promised not to watch. Closing it would require observing blocked apps, which is
the one thing the setting exists to prevent.

`captureEnabled` is the switch that does apply to both paths, and it had no way
to become true — nothing in the app set it, so every route to a recording was
closed on a fresh install. Connecting a machine turns it on, in the dialog where
somebody says this machine records their meetings.

### A microphone is never opened for a meeting nothing will transcribe

The desktop has two states in which it cannot produce a transcript: no grant on
the machine, and on-device chosen with no on-device engine built. In both, the
app records **nothing** — no `getUserMedia`, no permission dialog — and says
which one it is in a sentence naming the fix. The notes still become a note.

This is the phone's own answer (`notesOnlyRecorder`) rather than a second one,
and the argument is the same twice over: a meeting recorded with no transcriber
is a meeting somebody thinks they have and does not, and it is also somebody's
audio held open for no purpose. It has a third consequence here that the phone
does not have — macOS remembers a refusal, so raising the microphone dialog for
a session that will not open a microphone spends the one prompt a person ever
gets.

System audio is the same rule at a smaller scale. An unsigned build asks macOS
for the loopback tap and gets nothing; that is not a failure, it is mic-only,
and the panel says the far side of a call on headphones will not be in the
transcript. The probe *is* the attempt — there is no API that answers the
question without asking it — so the answer is remembered for the rest of the
launch and deliberately not persisted, because a signed build installed over an
unsigned one would otherwise inherit the old answer forever.

A "simplification" that opened the microphone anyway and let the transcript come
out empty would fail `an unconnected machine opens NO audio at all`,
`NO PERMISSION IS REQUESTED FOR A MEETING THAT OPENS NO MICROPHONE` and
`a build macOS will not give system audio to still records`.

### A chunk of audio is a whole file, and every recorder cuts on the same clock

`MediaRecorder.start(timeslice)` emits a blob every interval and only the first
one carries the container's headers. Every chunk after it is a fragment no
decoder and no transcription engine can read — so a recorder that streams
timeslices produces audio that looks fine in a log and transcribes to nothing.
The desktop capture window did exactly that, and nothing had noticed because
there was no transcriber on the other end yet; it would have transcribed the
first second of every meeting and silence after.

So a chunk is a whole recording — stop, hand over, start again — and the cost is
the few milliseconds of somebody still talking between the two, which is the
smaller one. Both mobile recorders already worked this way; the desktop now
does, and `SEGMENT_MS`, `MAX_INFLIGHT_CHUNKS`, `chunkIdFor` and `segmentIdFor`
moved to `@context/meetings/chunks` so there is one copy. An offset is the sum
of the durations before a chunk, so a second `SEGMENT_MS` on the laptop would be
a transcript whose `startMs` means something different from the phone's — the
kind of drift nobody sees until two clients disagree about when something was
said.

The checks are `packages/meetings/test/chunks.test.mjs` and, on the client side,
`its id is derived from the chunk, never taken from the answer` and
`a second chunk goes out while the first is still unanswered` — plus
`apps/desktop/test/captureWindow.test.mjs`, which drives the real capture module
against a fake browser, because this is a bug that hides: the fragments look
fine in a log and the failure presents later as "the first twenty seconds
transcribe and then it goes quiet". `A RECORDER IS STARTED WITH NO TIMESLICE`,
`EACH CHUNK IS A WHOLE RECORDING` and `OFFSETS ARE CONTIGUOUS ARITHMETIC` are
the three that fail if it comes back.

### A client-supplied id is bounded where it enters — and, since 2026-09-05, where it lands as well

**Amended.** This section used to end at "where it enters", and its premise was
that `normalizeSegment` in `packages/meetings/src/transcript.js` "accepts an
unbounded segment id: it trims, checks for non-empty, and stores." That is no
longer true, and the reversal is written here rather than left to be discovered
from the code, because a decision record asserting the negation of the shipped
behaviour is worse than no record.

`chunkId` arrives from a recorder and becomes a transcript segment id
(`${chunkId}-${index}`). The bound still belongs on the argument, for the reason
it always did — it is the contract's own input, it arrives from a client, and
every consumer downstream would otherwise have to distrust a value we handed it.
What changed is that the entry bound is no longer the *only* one.

**Why the second bound was added.** `normalizeSegment` is reached by a path the
entry check does not cover: `POST /meetings/sessions/:id/segments` takes segments
from any `context:write` grant directly, without passing through
`transcribeChunk` at all. The gateway caps a segment's text, one request body,
and how many segments a session holds — but never the size of the stored record,
so a padded id was the one field those caps did not reach. The record lives at
`.context/meetings/sessions/<id>.json`, and `isPlumbing` refuses a dot-prefixed segment
at every tier including the owner's, so the growth is invisible to the person
whose storage bill it lands on. `MAX_SEGMENT_ID_CHARS` = 200 closes it.

**What it is worth, stated honestly.** Roughly 38 MB per session, against a
legitimate ceiling of about 80 MB that those same count limits already permit
(20,000 segments × 4,000 characters of text). So this is a third off a ceiling
that is otherwise unchanged, not a new bound on how large a session may be.
**The larger axis is still open and is deliberately not closed here: nothing
caps how many sessions may exist.** A fresh `mtg_` id mints a new record every
time, each up to that ceiling, all under `.meetings/` and all equally invisible.
That is the same shape at N times the magnitude and it wants its own decision.

**The two bounds are coupled and nothing in the type system says so.**
`MAX_CHUNK_ID_LENGTH` = 128 keeps the longest real id at ~133, comfortably under
200. Raise it past 168 and every segment from the transcription path is refused
at the merge instead — silently, because no client reads the `rejected` count.
`apps/convex/__tests__/meetingTranscribe.test.ts` asserts the relationship, since
the two constants live in packages with separate test runners.

1 to 128 characters of `A-Za-z0-9_-`. The recorders mint `<Date.now()>-<index>`,
around seventeen characters, so the bound is enormously generous against the
real workload while refusing the two shapes that cause trouble: an id large
enough to matter written verbatim into a note, once per segment, in the
customer's own bucket; and characters that mean something to a Markdown
renderer, a path resolver or a shell. The refusal is its own code —
`INVALID_CHUNK_ID`, not the deployment-problem code the other refusals share —
because it is the only one here a *client author* can act on, and it never
quotes the rejected value back, because that is how a refusal becomes a
reflection. It is checked after authentication, like everything else: the shape
of an unauthenticated caller's arguments is not something to tell them about.
The checks are `refuses an id longer than the bound, before spending any
inference`, `refuses characters that mean something to a renderer, a path, or a
shell`, `the refusal names the field without quoting what was sent` and
`an anonymous caller with a bad chunk id is still just anonymous`.
### The device is never waiting on the network, and a backlog is dropped rather than kept

**Amended 2026-09-18: the second half of this title is reversed.** A backlog is
now *kept*, on the device, and the section that says so — *Audio nobody has
transcribed yet is kept on the device*, next — records what that costs. The
first half stands: the send is still off the chain that owns the microphone,
and everything below about offsets, chunk ids and releasing the device is
unchanged. The paragraph that argues for dropping is left as the record of the
decision that was reversed, not as current behaviour.

Capture rotates on a fixed wall clock, and the first version of it closed a
chunk, **awaited the transcription round trip**, and only then reopened the
microphone. That is 1.5-4s of every twenty seconds never recorded, cut mid-word,
on both platforms — 8-20% of a meeting — while the offset arithmetic went on
asserting the chunks were contiguous, so the transcript's timestamps claimed
audio that had never existed. On a slow link it was worse than lossy: if a round
trip outran `SEGMENT_MS` the interval kept firing, the backlog grew with no
ceiling, and the offsets diverged from wall clock permanently while the recorder
still reported `state: "recording"`.

So **the send is not on the chain that owns the device.** A rotation closes the
file, reopens recording, and hands the bytes off; segments arrive whenever they
arrive, which costs nothing because a `TranscriptSegment` carries its own id and
`startMs`. Out-of-order arrival is acceptable; silently missing audio is not.

That leaves a bound to choose, and what happens at it is the actual decision:
**at `MAX_INFLIGHT_CHUNKS` a chunk is dropped, with an honest sentence on the
screen, rather than queued.** Queueing means holding somebody's audio past the
moment it would otherwise have been deleted — on the phone, keeping the `.m4a`
in the cache — and "the file dies before the request that carries its contents"
is what makes *audio is never persisted by us* a property of the code rather
than a line in this document. A bounded queue also only moves the same decision
`MAX_INFLIGHT_CHUNKS` chunks later, by which time the backlog is minutes rather
than seconds and nobody has been told anything.

Two rules follow from the same place, and both were wrong before they were
written down. **The offset is session time and it moves whatever else fails** —
a chunk the device would not close, a chunk with nowhere to send, the seconds an
interruption cost: all of it is time that passed, so every later chunk starts
that much further along, and a flag's `at` lands on the sentence it was pressed
during. **A chunk id, conversely, is spent only when there is a request to carry
it**, so a run of bad chunks leaves no gaps in the sequence.

And **releasing the device may never depend on the send.** `stop()` awaited the
last chunk's transcription before releasing, so ending a meeting with no signal
— the ordinary case, not the edge one — left the microphone open: iOS's red bar
for the life of the process, the browser's recording dot for the life of the
tab. The release is unconditional now, and waiting for outstanding sends happens
after it, where it costs a spinner rather than a microphone.

The same rule reaches the other end of a recording. Nothing swept the recording
directory at startup, so a crash or a force-quit mid-chunk left up to
`SEGMENT_MS` of somebody's meeting in the app's cache permanently — while the
code claimed in prose that it could not. The sweep runs when the capture module
is first evaluated, which is the one moment in a runtime where no recorder
exists for it to race.

The checks are `rotation reopens the microphone without waiting for the
answer`, `a backlog is bounded, and what it drops it says`, `a chunk that will
not close does not take the next twenty seconds too`, `an interruption's lost
time lands in the offset`, `a chunk whose path the file system refuses still
releases the device`, and `a recording a previous run left behind is swept at
startup`.

### Audio nobody has transcribed yet is kept on the device

The owner's call, 2026-09-18: **offline audio is spooled, never dropped.** A
meeting recorded in a basement, on a train, or on one bar of signal came out of
the app with a transcript full of holes, because every chunk sent without a
connection failed once and was gone — its file had been deleted *before* the
request that carried it, which was the point — and past
`MAX_INFLIGHT_CHUNKS` the recorder dropped chunks outright with a sentence
saying so. Losing signal is the ordinary case (*Ingestion is idempotent by
construction*, above), and the words a meeting recorder most needs to keep are
the ones it could not send.

**What is built.** Every chunk a phone records is written into a spool before
it is sent — `apps/mobile/features/meetings/capture/spool.ts`, one file per
chunk under the app's *documents* directory, named
`<index>_<offsetMs>_<durationMs>.<wav|m4a>` in a folder per meeting, so the
file name is the whole index and there is no manifest to disagree with it. A
chunk is sent when there is a connection and fewer than `MAX_INFLIGHT_CHUNKS`
already out; otherwise it waits. It is deleted only once the transcriber has
answered for it **and** its words have been handed to its meeting (and, on the
drain's path, written down on the device). What waits is sent by
`spoolDrain.ts` — on launch, on reconnect, on returning to the foreground, and
after End — sequentially, oldest meeting first, in index order, through the
same `transcribeChunk` with the same chunk id, offset and duration.

- **`MAX_INFLIGHT_CHUNKS` is about network concurrency and nothing else now.**
  Chunks in the spool are not in flight. Recording goes on for as long as the
  meeting does, offline, with no bound.
- **Offline, nothing is dispatched.** `ConvexReactClient.action()` has no
  timeout: offline it holds its arguments — here twenty seconds of base64 — until
  the socket returns. Sending anyway would put an hour of a meeting in the heap.
  The reachability hook's "offline" is mirrored into `capture/connectivity.ts`.
- **The note waits for its audio.** `sync()` does not finalize a meeting while
  its audio is still waiting, because `complete` refuses every later segment
  (`acceptsTranscript`) and the words would arrive to a note that can no longer
  take them. `recoverStaleFinalizes` skips such a meeting (it is waiting, not
  stuck), and End no longer calls a meeting whose only content is kept audio
  `empty`, which is terminal.
- **Idempotency is the chunk id's, and needs no server change.**
  `transcribeChunk` derives every segment id from the chunk id and the
  segment's position, so the same chunk answers with the same ids
  (`two identical calls produce identical segments`), and the meeting upserts
  by id. Making the server "remember" a chunk would mean the control plane
  holding a transcript, which non-negotiable #1 forbids. The one residual:
  Whisper re-run on the same audio could split it into a different number of
  segments, and then a re-sent chunk whose first answer *was* folded in leaves
  the extra rows of the longer answer. That needs an answer to be folded and
  its chunk then re-sent — a crash in the milliseconds between the two — and
  the drain orders it so that is the only way.
- **A send that outlives its meeting leaves its chunk for the drain.** The
  recorder emits only to a listener for the meeting a chunk names; a send that
  answers after End's wait, or after the next meeting has started, leaves the
  chunk where it is and the drain delivers it by id. The same change made End
  hold its listener until its wait is over, which fixes an older loss: the last
  seconds of every meeting were emitted after the controller had stopped
  listening.
- **One bad chunk cannot hold a note forever.** A chunk the transcriber refuses
  on its own merits (`TRANSCRIPTION_FAILED`, `INVALID_CHUNK_ID`) is set aside
  after `MAX_REFUSALS` in one process: it stops holding its meeting, stays on the
  device, and is counted on the screen as kept and not transcribed. A network
  failure, a rate limit or an expired session is never counted against a chunk.
- **Somebody's content, not a cache** — the rule the offline layer already keeps
  for a queued write. Nothing sweeps the spool, nothing bounds it, nothing ages
  it out. A chunk leaves because its words arrived, because the person
  discarded its meeting, or because they signed out: `forgetLocalCopies` wipes
  it first (it needs no store, so a failing store cannot stand in front of it),
  after `endSession()`, and re-counts rather than trusts. Every write carries the
  epoch the recording started under and is checked on both sides of the write,
  so a recorder still running behind a sign-out writes nothing and a write the
  sign-out overtook is taken back. **And the person is asked first**: the
  sign-out question counts meetings with audio on the phone
  (`unsentMeetingAudio`) beside unsent note edits and says *"1 meeting's audio
  has not been transcribed yet — signing out deletes it from this phone"*;
  without it, sign-out was a silent way to lose exactly what the spool exists to
  keep. `asks first, naming the meeting whose audio would be deleted`
  (`signOutHygiene.test.ts`) fails if the spool is left out of the count.
- **Written beside, then moved in.** Bytes go to `<name>.part` and are renamed
  when whole; a crash mid-write leaves a `.part` that is never listed or sent.
  A refused write removes its own `.part`.

**What the person sees.** Recording offline, the live screen's chip says
*"Offline — recording is saved on this phone and will be transcribed when
you're back online"* with the count waiting, and it outranks a capture error
(offline, that error is the same fact said worse). The recording bar, which has
room for two words, shows *On phone · N* with the whole sentence as its label.
An ended meeting whose audio is waiting says the note is written once the
pieces are in; the transcript says *Incomplete — N pieces of audio on this
phone are not in this transcript yet*; set-aside audio is said to be on the
phone and not in the note. All of it is one pure module, `keptAudio.ts`.

**A browser keeps nothing, and says so.** `spoolDevice.web.ts` is `null`. Holding
minutes of somebody's meeting in IndexedDB on a machine that may be shared,
under a quota the browser evicts without asking, is a different decision from
the phone's and was not taken. Offline, `audio.web.ts` no longer dispatches
into a socket that will not answer; it says once that this stretch is not being
transcribed, that typed notes are still saved, and that the phone keeps audio.
Browser *dictation* offline now names the computer's own dictation (macOS and
Windows both have it) instead of "the words cannot be made right now", and
checks `navigator.onLine` before it opens the microphone.

**What it costs, stated.** The audio of a meeting now exists on the phone for as
long as it takes to reach the transcriber — minutes normally, days if the phone
stays offline — which is exactly the property the old design existed to rule
out, and "audio is transient" is now true of everything *except* the
customer's own device. On iOS the documents directory is included in the
person's device backup, and this `expo-file-system` has no way to exclude a
file; it is their backup of their meeting, and a chunk is gone from the device
the moment its words land. A note waits for its audio, so a meeting recorded
offline is not in the bucket until the phone has been back online long enough
to send it — twenty chunks a minute, so an hour offline is about nine minutes
of sending. And uncompressed 16 kHz audio is about 115 MB an hour on a phone
that has no signal to send it.

**What a "simplification" would cost.** Deleting the file before the send again
is the transcript full of holes this reversed. Bounding the spool, or sweeping
it by age, is a meeting silently losing its middle on the day somebody was
offline longest. Finalizing without waiting for the spool writes the note
without the words and then refuses them when they arrive. Dropping the epoch
checks puts one person's meeting audio on the device after they signed out, for
the next person to have sent under their own session.

**The tests that fail if it is reversed**, each sabotaged and seen to fail:
`a send that fails keeps its chunk, and says it is kept rather than lost`,
`offline, nothing is sent and every chunk is kept, well past the in-flight
bound`, `with the sends backed up, the rest are kept rather than dropped` and
`an answer that arrives after its meeting has moved on leaves the chunk for the
drain` (`meetingsCapture.test.ts`); `a meeting is not written while its audio is
still on the phone`, `audio on the phone and nothing else is still a meeting`,
`waiting on audio is not mistaken for a stuck finalize`, `a chunk sent twice is
in the transcript once`, `words that come back while End waits reach the
meeting` and `sign-out takes the audio with it` (`meetingsKeptAudio.test.ts`);
`a chunk is let go only after its words are written down`, `a lost connection
stops the pass and sets nothing aside` and `a sign-out during the round trip
delivers nothing and confirms nothing` (`meetingsSpoolDrain.test.ts`); `a write
that a sign-out overtook is taken back`, `a wipe that did not land says so` and
`only whole chunks are listed` (`meetingsAudioSpool.test.ts`).

**Not verified by any of this: a device.** Every test drives fakes of
`expo-audio` and `expo-file-system`. Before this is trusted, on a real iPhone
and a real Android phone: record in airplane mode for at least three minutes
(locked for part of it), and confirm the chunk files under
`Documents/meeting-audio/<meetingId>/` grow and the live chip says the audio is
saved; end the meeting offline and confirm the note says it is waiting; turn
the network back on and confirm the transcript fills in order, the files go,
and the note is written once; kill the app mid-meeting offline, relaunch online
and confirm the failed meeting still gets its words; sign out with audio
waiting and confirm the folder is gone.

### The recorder is one interface with two implementations, and nothing above it knows which

Both engines sit behind one recorder interface: start, feed audio, emit
`TranscriptSegment`s, stop. The session reducer, the note renderer, the
detection rules and the gateway are written against `TranscriptSegment` and
have no idea what produced one.

The pressure against this is specific rather than hypothetical. Cloud engines
stream partial hypotheses that get revised; on-device engines emit finalized
utterances on their own schedule; one gives you speaker labels and confidence,
the other gives you `null` for both — which is exactly why those two fields are
nullable in the contract rather than optional. It is very easy to let one
engine's shape leak upward "just for now", and then the free tier is a
degraded special case of the paid one instead of a first-class path.

The check is `the session reducer imports no recorder`, and the useful form of
it is a test that drives the whole pipeline from a fixture segment list with
`speaker: null` and `confidence: null` everywhere and still produces a complete,
sensible note.

### The watch is a remote control, never a recorder

Five verbs — `start`, `end`, `pause`, `resume`, `flag` — and one small state
snapshot back. No audio, no transcript, no note content crosses to the wrist.

The verb is `end` rather than `stop` because `MeetingEvent` already calls that
transition `end`, and two words for one transition across a boundary is the
drift the contract exists to prevent. The wrist may still *say* "Stop" to its
wearer; a label is not a protocol.

This is not a scoping decision to be revisited when the hardware improves. The
watch microphone is a wrist-height microphone in a room, the battery does not
survive a forty-minute capture, the transport between watch and phone is
intermittent by design, and Apple's on-device transcription stack is available
on every platform they ship *except* watchOS. A watch that recorded would
produce a worse transcript, at a battery cost the wearer notices, over a link
that drops — and it would need somewhere to put a transcript on a device with no
room for one.

What the wrist is genuinely good at is the thing the phone is bad at: being
reachable without being taken out. Starting before a call, ending one from the
corridor, and marking a moment mid-sentence without breaking eye contact.
`flag` is the verb that only exists because of the wrist, and it is the reason
`WatchState.flags` is a count rather than a list — the wearer needs to know the
press registered, not to read back what they flagged.

**A flag has to reach the note, and its timestamp is taken on the wrist.** The
count was all there was for a while: `WatchCommand` had the verb, `WatchState`
had the number, and there was no `flag` event and no field on the session, so a
press could not reach the note it was pressed for. It is now a `MeetingFlag` —
`at`, and an optional label bounded by `WATCH_FLAG_LABEL_MAX` — folded by the
reducer and rendered by `note.js` as a `> [!flag]` callout beside the turn it
belongs to.

`at` is **milliseconds from the start of the session, computed at press time**,
and that is the whole decision rather than a detail. The transport between a
watch and a phone is intermittent by design, so a queued command drains late;
timestamping on arrival is a minute of drift, and a minute of drift puts the
mark on the wrong sentence — which is the only thing a flag has to get right.
Deduping on `at` is what keeps a replayed log from doubling a press. The checks
are `a flag lands after the turn it was pressed during`,
`the same press folded twice is one flag`, and
`a meeting with flags and no transcript writes the flags`.

The two properties worth holding: **the phone is the authority** — a command is
a request the phone's state machine may refuse per `MEETING_TRANSITIONS`, never
a state change the watch performs — and **`reachable` is a first-class field**,
because a watch that cannot reach the phone must show that rather than showing a
stale timer that looks live. The phone being the authority is why every command
about an existing session **names it**: a watch shows the session it last heard
about, the link drops, the phone starts a second meeting, and the pause pressed
on a stale face would otherwise land on a meeting nobody is looking at. The
checks are `a watch command carries no audio and no transcript` and
`an illegal watch command is refused rather than applied`.

The staged plan, and what a watchOS target actually costs from this Expo app,
is in [watch-companion](../meetings/watch-companion.md).

### Detection judgement is a pure function, and the desktop app only collects evidence

`DetectionSignals` is deliberately dumb data: process names, window titles and
URLs, whether something else holds the microphone, and the calendar events near
now. The platform-specific code — which is the part that has to be written three
times, in three languages, against three sets of OS APIs — collects that and
nothing else. Every judgement is made by pure functions in
`packages/meetings/src/detect.js`.

The reason is that detection is the part most likely to be wrong in a way that
matters. A false positive records a doctor's appointment. A false negative loses
the meeting the customer bought this for. A flicker — one poll where a window
title changed — must not start a recording, and a two-second network blip must
not end one, which is what `DETECTOR_THRESHOLDS` and `DetectorState` exist for.

Rules that live in the desktop app can only be tested by holding a meeting.
Rules that are a pure function of a signals object can be tested with a fixture
that never runs, and every platform gets the same answer to the same evidence —
which also means a wrong guess can be *replayed*: `DetectionResult.reason` and
the retained `source.app` / `source.url` exist so "why did it think I was in a
meeting" has an answer better than a shrug.

The checks are `a single-poll flicker never starts a recording`,
`a gap shorter than the threshold never ends one`, and
`the same signals produce the same result on every platform`. The last one is
the one a "small platform-specific tweak" breaks first, so it is written as a
shared fixture suite rather than three parallel tests.

### The state table is the client's, and a move it refuses is a client faking one

`MEETING_TRANSITIONS` is the whole of what a meeting may do, and a reducer that
cannot make a move throws rather than guessing. That makes the table a promise
about clients, and a client that needs a move the table does not have does not
stop needing it — it forges the nearest event that gets there. Three of those
were happening, and each was found by a surface reaching for a lie:

- **`idle -> finalizing`.** A meeting nobody recorded is still a meeting. The
  microphone was refused, or there was never anything to capture, and somebody
  typed for forty minutes. Their words are the half of a meeting that cannot be
  regenerated — the summary can always be re-run, the transcript is gone either
  way — so refusing to write them out until a `start` had been forged was the
  product inventing a recording in order to be allowed to save the notes.
- **`finalizing -> recording`.** A finalize the gateway has not answered yet is
  not a finished meeting; the person is still in the room. The alternative was
  the phone sending itself a `fail` to get back, which writes a failure that
  never happened into the record somebody may later read.
- **`failed -> finalizing`.** A recording that dropped mid-meeting holds a
  partial transcript, and a partial transcript is somebody's meeting. Without
  this move the only exit from `failed` is to record again, so a session that
  cannot record again could never be written out at all.

What a "simplification" costs is the reason the table was tight in the first
place, and it is still right: `complete` stays terminal, nothing returns from
it, and every move that changes state still needs the client's own timestamp so
that replaying a log lands where it landed the first time. That is also why
`fail` now carries an `at` like every other state-changing event — without one
the reducer had to recognise a replayed failure by the *reason* it left behind,
which meant `failureReason` had to survive a restart, which meant a session that
had recovered still said why it once failed. With a timestamp, the reason means
exactly one thing: it is why this session is in `failed`, and it is cleared on
the way out. The same timestamp is what lets a failure close the open recording
span honestly — the audio up to the moment the recorder died is counted, and the
minutes until somebody notices are not.

The checks are `a meeting nobody recorded still finalizes`,
`a failed recording can be written out with what it captured`,
`a finalize that has not landed can be taken back to recording`, and
`a fail with no timestamp is refused, like every other state-changing event`.

### `written` is the gateway's word, and a client may never say it

Every other event in the contract is something a client observed. `written` is
not: it says a note exists in the customer's bucket, and the only party that can
know that is the one that wrote it.

A client able to send it could move its own session to `complete` with a
`notePath` pointing at nothing. The meeting would then be, to every surface that
looks, a finished meeting — off the device's "still here" list, out of the sync
queue, drawn as saved — and the recording would be gone in silence. That is the
one outcome this feature exists to prevent, and it is worth more than the tidiness
of a symmetrical event list.

So the union names it as the gateway's, `CLIENT_EVENT_TYPES` is exported from the
contract as the list of everything else, and the gateway checks against *that*
list rather than a copy of its own. A copy is how the rule gets relaxed by
somebody adding an event next year. The check is
`a client cannot send the event that says a note was written`, and it is
sabotage-tested: allow `written` through and two checks fail, one of them the
forged completion of a meeting whose note was never written.

### A meeting route is a reserved name, not somebody's handle

`/meetings/sessions` is where every recorder posts. Usernames and workspace
slugs are the first path segment on the same gateway, so until `meetings` joined
the reserved list, that path parsed as "the context called meetings, at the path
`/sessions`" — and the gateway defended itself by lifting meeting paths out of
the workspace selector before it ran.

That defended the route and left the hole. **The name was still claimable**, and
a name in this namespace is also a mailbox on the apex
([identity-and-access](./identity-and-access.md), *Ingestion is on the apex,
which makes the reserved-name list a security control*): whoever registered
`meetings` would have held `meetings@` the company's own domain, and every
device in the product would have appeared to be addressing their handle. The
route-shaped half is not academic either — a context genuinely called `meetings`
is a context nobody can address by name.

So the segment is reserved in the gateway's own list, reserved in the control
plane's `RESERVED_NAMES`, and the workaround is gone: one rule, enforced where
names are handed out, rather than one route holding a door shut by itself. The
control plane's test reads the gateway's list out of its own source, so a route
added next year fails on the day it is added rather than on the day somebody
claims it. The checks are `a meeting path names no workspace, whatever anybody
registered`, `reserves every gateway route a name could otherwise be`, and
`a workspace registered as `meetings` does not take the ingestion route`.

### An ack says whether the write was conflict-safe, because some buckets are not

Reads return a version and writes pass it back — except that Backblaze B2 and
Wasabi accept `If-Match` and write anyway. The capability is therefore probed
against the actual bucket at connect time and recorded on the binding, and the
rule is that it is **never silently dropped**.

`IngestAck.conflictSafe` is how that rule is kept in front of the client rather
than in a document: every meeting request is answered with whether this
context's bucket can do a conditional write at all. A client on a bucket that
cannot is being written last-writer-wins, and it is told, on every request,
rather than left to assume the guarantee it read about.

The half that made it a lie for a while was one line: the gateway built every
store with the *adapter's* declaration — true, because every adapter sends the
header — and never read the probed answer off the binding. So the ack claimed
conflict safety on exactly the backends that do not have it. The capability is
applied where the store is built, it only ever lowers, and a binding carrying no
probed answer is treated as unproven. The checks are
`a binding whose bucket cannot do a conditional write builds a store that says
that` and `a context on a bucket that ignores If-Match is told so on every ack`.

### Ingestion is idempotent by construction, because losing signal is the normal case

A phone in a basement conference room drops off the network for ten minutes.
This is not an error path; it is Tuesday. So the client keeps its own event log,
replays it on reconnect, and the gateway is built so that replaying is free:

- **The same session id upserts.** Posting session metadata twice is one session.
- **The same segment id replaces.** `TranscriptSegment.id` is client-generated
  and stable, which is why the contract says so in the type's own comment.
  A client that re-sends a whole batch after a timeout it never saw the response
  to must not double the transcript.
- **Finalize on a complete session returns the note path it already wrote.**
  Not a second note, not an error the client will retry forever.

The third one has a trap that is worth naming, because the obvious
implementation walks into it. If the bucket path is derived from the title, and
the human renames the meeting between a failed finalize and its retry, a
title-derived path produces a *second* note and both look correct.

So **the path is composed once and then remembered.** Finalize's first step is a
*claim*: it works out the path, writes it into the session record under a
conditional write, and only then writes the note. Every later finalize —
a retry after a crash, a duplicate from a client that never saw the first
answer, a re-finalize under a new title or a different folder — reads that path
back out of the record and does not compose one. A rename rewrites one note; it
cannot fork one, because after the claim nothing derives a path from anything.

**This paragraph used to say something else, and it was wrong.** It said the
path "carries a stable suffix taken from the session id, and finalize resolves
an existing note **by that suffix** before it composes a new path". The first
half is true — `meetingNotePath` ends the filename with the tail of the session
id — and the second half describes a lookup that does not exist and would be a
worse design: resolving by scanning for a suffix means reading the bucket to
answer a question the record already answers, and it would find a note in the
old folder while the retry named a new one. `unclaimedNotePath` is the only
thing here that looks at an existing key, and its job is the opposite: it
refuses to overwrite a note somebody else's tooling put at the candidate path.

Every `MeetingEvent` in the contract is idempotent or additive for the same
reason: replaying the log must land on the same session.

The checks are `finalizing twice answers with the note that already exists`,
`a phone that lost signal and re-sent duplicates nothing`, and
`a re-finalize with a changed title rewrites one note rather than adding a
second` — the last of which this section cited for a while before it existed,
and which now does: it fails a finalize's note write, renames the meeting, and
asserts the retry lands on the first title's key with no second note in the
bucket.

### The human's words are never rewritten, and the generated half is disposable

`MeetingSession.notes` is what the person typed. `enhanced` is what the model
produced. They are separate fields, they render as separate headings, and the
enhancement pass reads the first and writes the second.

This is the same asymmetry as `index.md` in [gateway-protocol](./gateway-protocol.md):
the generated part can be regenerated, so losing it is never data loss, while
the part only the human can write has no source to rebuild it from. It also
makes "re-run the summary" safe to offer as a one-tap action, which it would not
be if the two shared a heading.

The check is `re-enhancing a meeting leaves the human's notes byte-identical`.

### A meeting lands at an ordinary path, and nothing about it is namespaced

`0-inbox/meetings/2026-09-05-<slug>-<suffix>.md`, where `<suffix>` is the
stable tail of the session id. It is an ordinary note under the customer's
ordinary folders: no `meetings/` bucket, no tenant prefix, no reserved
directory, nothing to migrate ([non-negotiable 2](../../CLAUDE.md)).

Two consequences that are decisions rather than accidents. The folder is a
**default the customer can change**, because PARA is a suggestion and someone who
files meetings under `2-areas/team/` should keep doing that — and the moment
they move a note, the note *stays* moved, because nothing holds a second copy of
its path. And nothing in the gateway parses a path to find a meeting, because a
path that has to parse is a path that cannot be moved.

The check is `moving a meeting note does not break reading it`.

**There were `YYYY/MM/` folders under that path and there are not any more.**
They were kept "for humans and for Obsidian", against one folder accumulating
every meeting a person ever recorded. Used for a while, the tree is the half
that is unusable: somebody recording twice a month gets two directory levels per
meeting, most of them holding one note, in front of a filename that already
opens with the same date — so reaching a meeting is two folders deep and a
listing of the year shows twelve folders instead of the meetings. A flat folder
sorted by name is the ordering the tree was drawn to give, one level up.

Reversing it costs nothing to reverse *again* — the folder is the customer's and
the notes are files — and it changes what the two path functions do, in opposite
directions. `meetingNotePath` writes `<folder>/<file>` and nothing between.
`isMeetingNotePath` reads **both** shapes, permanently: `list_meetings` is built
out of it and out of no index, so a recogniser that read only the flat shape
would not migrate anybody's bucket, it would silently stop calling their
existing meetings meetings while the files sat there untouched.

**And the slug in that pattern is one segment.** It was `.+`, which matches a
separator, so accepting the flat shape also accepted
`0-inbox/meetings/2026-03-04-offsite/agenda.md` — an ordinary note, inside a
folder somebody happened to name after a date, listed and read as a meeting. The
dated branch had the same hole before the flat one existed, so `[^/]+` closes a
latent case as well as the one this change opened. It is the same claim the
folder rule makes from the other side: a meeting is one file directly in the
folder it was filed into, and the point of no longer nesting is that there is
nothing under it. `list_meetings`
also sorts on the *filename* rather than the whole key for the same reason —
`/` sorts above `-`, so whole-key order put every dated-folder meeting ahead of
every flat one regardless of date. The checks are
`no date folders: the key is the folder and a filename, nothing between`,
`a meeting filed under the old YYYY/MM folders is still recognised`, and
`...but a deeper tree than either shape is still not a meeting`.

**"A default the customer can change" was a sentence for a while and is now a
field.** A phone can ask a person where a meeting's notes should go, and the
gateway ignored the answer: `finalizeSession` built the inbox path from
`MEETINGS_FOLDER` and consulted nothing, so somebody who picked a folder got the
inbox anyway, in silence. `FinalizeBody.folder` is that answer arriving.

**A destination is a `(context, folder)` pair, and only the folder half is this
field.** `MeetingDestination` in the app
(`apps/mobile/features/meetings/destination.ts`) carries a `contextSlug`
alongside the folder, and **the context half is the one carrying a privacy
rule**: the first offer on the sheet is always the person's own workspace, whatever
context they happen to be standing in, because somebody reading a note in a
shared workspace who presses record would otherwise drop a transcript of a
conversation they have not read yet into a folder their colleagues are watching.
The current page is the *second* offer, with its audience named on it.

The gateway sees only the folder because the context has already decided *which
gateway and which bucket* the finalize is addressed to — one workspace is one
bucket, one storage binding and one privacy manifest
([non-negotiable 2](../../CLAUDE.md)) — so there is nothing for a `context`
field on this body to mean that the connection does not already say. Three
decisions in the folder half, each of which could reasonably have gone the other
way:

**The chosen folder replaces the whole default, and the note is dumped in it.**
`MEETINGS_FOLDER` is one concept — where meetings are filed — spelled in two
segments, so `2-areas/team` gives `2-areas/team/<file>` rather than
`2-areas/team/meetings/<file>`. The alternative hands a person a folder they did
not ask for, and the example this section already used for a customer who has
changed it has no `meetings` segment in it. Nothing is interposed under the
chosen folder either — see the date folders above.

**Which is why the phone's default row is `0-inbox/meetings` and not
`0-inbox`.** It was the latter, derived from `DEFAULT_TARGET_FOLDER` — where
forwarded mail lands — on the reasoning that a meeting is the same kind of
unfiled capture. True about the inbox, wrong about the folder, because of the
rule in the paragraph directly above: a chosen folder replaces the whole
default, so offering the bare inbox did not mean "the default, unchanged", it
meant "not `0-inbox/meetings`". Every meeting recorded on the default row landed
loose in the inbox beside the mail, and the sheet showed a folder the person had
not chosen and would not have. `0-inbox` is where unfiled things arrive and what
arrives there is sorted by what it *is* — `0-inbox/meetings`,
`0-inbox/sessions`, mail beside them. The check is
`the default is the meetings folder inside the inbox, not the inbox itself`, and
`the offered default is exactly what the gateway files into when nobody chooses`
imports the real `MEETINGS_FOLDER` so the phone's spelling cannot drift from the
gateway's.

**Moving a default has to reach the devices that already recorded a meeting, and
this one would have reached them the worst way.** A remembered `0-inbox` no
longer matches the inbox row — but it *does* match the current-page row for
somebody standing in their own `0-inbox`, so the sheet would open preselected on
the row that files the meeting loose in the inbox, silently, exactly where the
old default used to be. A default that moves for new devices and persists on old
ones is two products. `recallDestination` therefore forgets a remembered
`personalInbox` naming the old folder, and only that: until this change the
inbox row and the page row deduped whenever they named the same folder, so
standing in `0-inbox` and pressing record offered *one* row — there was no
separate deliberate choice to preserve. A `currentPage` choice is a decision
about a folder somebody navigated to and survives, `0-inbox` included. The
checks are `a device that remembered the old default gets the new one, not the
old row` and `...but a folder somebody actually navigated to is still
remembered`.

**A folder the gateway will not file into is refused by
`normalizeMeetingFolder`, which delegates to `normalizeRoot` rather than being a
third validator.** The structural rules are the same rules — traversal,
backslashes, separators — and two implementations of "does this escape its
bucket" is how one of them ends up weaker. `slugifyTitle` is the wrong half of
the precedent: it *maps* rather than refuses, so `2-areas/team` would come back
as `2-areas-team` and the note would be filed into a folder nobody named. What a
folder needs on top of what a root needs is seven rules with seven reasons: no
dot-prefixed segment, because `isPlumbing` hides those from every tool at every
tier including the owner's, so the meeting would be invisible to the person
whose storage bill it is; no segment that is itself a note or the legacy
`scopes.yml` manifest; no control characters, because this string reaches a
listing, an audit row and somebody's file browser; a length bound keeping the
whole key inside the gateway's own 512-character path limit;
**no `..` anywhere inside a segment**, not merely a segment that *is* `..`;
**no segment that percent-decodes to `.` or `..`**, because the storage adapter
decodes before it compares and neither of the two rules above does; and **no
whitespace at either end of the result**, which is not a rule about folders at
all but about this function — see below.

The `..` rule is the one that closed a real defect, and this paragraph said
"three rules with three reasons" and never mentioned it. **The count has since
been wrong three times more**: once per rule added below it, and then once
without any rule being added at all — review counted this list against the code
and found it had never mentioned control characters, while the docblock reached
its own "six" by pairing that refusal with the length bound. Two lists counting
the same seven rules two ways is how one of them drops one, which is the
argument for reading a count as a checklist against the code rather than as
prose. `normalizeRoot` refuses
the traversal *shapes*, which is the right rule for a prefix; the gateway's own
`normalizePath` is blunter and refuses `..` anywhere in a key at all. So `a..b`
passed the folder check, the claim wrote `a..b/….md` into the session
record under a conditional write, and the note write then answered 400
`meeting_invalid` — the code no client retries — for the life of that meeting,
with nothing to clear the claimed path. Only a `null` from
`normalizeMeetingFolder` reaches the `folderRejected` fallback, so that class
walked straight past the safety net the fallback exists to be. The two functions
have to agree about what a key is, and this one takes the stricter rule: a vault
with a folder named `a..b` loses it as a meeting destination and is told so,
where the reverse loses a meeting silently and permanently.

**The last rule is about idempotence, not about paths.** `normalizeRoot` trims
the whole string and collapses separators; it does not trim a segment. So
`"/ /"` came back as `" "` and normalizing *that* gave `null` — the function
did not accept its own output. `meetingNotePath` re-normalizes whatever it is
handed and the gateway hands it this function's answer, inside the claim
mutator, so the throw surfaced as a 400 blaming `startedAt` on a session whose
timestamp was fine. The rule is on the JOINED result rather than per segment
because a whole-string trim only reaches the two ends: `2-areas/ team` is
stable, builds a path, and is accepted everywhere downstream, and a per-segment
rule refused 36 such folders for nothing. Refusing a folder a vault could have
is the same defect as filing into one it could not, pointed the other way.

**The empty string is refused as well**, and it is a difference of *meaning*
from `normalizeRoot` rather than an addition to it: `""` is that function's
answer for "no prefix at all", which is a legal root and is not a folder. Filing
there would put a pile of meeting notes beside `index.md` and
`privacy.md`, and the on-bucket layout is a stable format rather than an
internal detail (CLAUDE.md, non-negotiable 3). The phone's destination sheet
refuses to *offer* the root for the same reason rather than letting the fallback
absorb it — see `features/meetings/destination.ts`.

The refusal is a `null` rather than a thrown message, because `normalizeRoot`'s
messages quote what they refused — reasonable for a prefix the customer typed
into their own binding, a reflection for a value a client sent.

**A refused folder does not lose the meeting: it falls back to the default, and
the ack says `folderRejected`.** This is the same trade as an unusable flag row
costing that row rather than the request — `meeting_invalid` is the code a client
does not retry, so failing the finalize would park somebody's forty minutes over
one bad string. The *saying so* is the load-bearing half rather than a nicety: a
fallback nobody is told about is precisely the defect being closed, one layer
down. The ack carries no copy of what was sent.

**And the folder is an input to the claim, and only to the claim**, which is
what keeps a client-supplied path component from being a new way to break
*Ingestion is idempotent by construction*. The claimed path is written into the
session record under a conditional write and reused by every later finalize, so
the same session finalizing twice under two folders answers with the note that
exists. Moving a meeting is `move_note`'s job and stays moved; a second finalize
is a retry, not a move. The sabotage that proves this is the storage-failure
retry rather than the obvious double finalize — an already-complete finalize
returns before the claim, so it forks nothing even with the guard removed, while
a retry after a failed note write, naming a second folder, writes a second note
and leaves one meeting in two places.

`isMeetingNotePath` takes the same folder and validates it with the same
function, so the pair agree by construction rather than by both deriving one
constant. It stays a shape test relative to a named folder and does not become a
global "is this a meeting" oracle, and the reason is a narrow one that used to be
stated too broadly. **The claimed path *is* recorded** — the session record
carries `notePath`, and the completion receipt keeps it, which is what makes a
retry land on one note. What no index records is the reverse mapping: there is no
list of meeting paths to scan, by the decision above, so `list_meetings` has
nothing to consult and reads the default folder off the bucket instead. Scanning
the whole bucket for `YYYY-MM-DD-*.md` would call somebody's ordinary dated
note a meeting.

So `list_meetings` does not list a meeting filed elsewhere, which is the
behaviour a *moved* meeting already has and which this section already calls
correct — and since that is a real limit rather than an implementation detail,
**the tool says so to the model in its own description**, because a client that
is told "the meetings the user recorded" has no reason to look further when one
is missing. The checks are in `apps/mcp/test/meetings.test.mjs`, on the
description a real `tools/list` returns.

The checks are `a chosen folder replaces the whole default, and keeps the date
folders under it`, `the recogniser answers true for every key the builder makes,
on the same options`, `a folder that tries to leave the bucket does not lose the
meeting`, `the client is told its folder was not used`, `and is not read its own
value back`, `finalizing again with a different folder answers with the note that
already exists`, and the one that matters, `the retry lands on the path the first
finalize claimed, not the folder it just named`.

**The wedge a tier refusal leaves is closed on the gateway and open on the
phone**, and that half is written down here rather than fixed, because fixing it
is a change to what the destination sheet is for.

Gateway side: a folder this connection's tier may not write is a *deterministic*
refusal, so `releaseClaim` gives the reserved path back on a 400 or a 403. The
session returns to `finalizing` with no path, "and the next finalize claims one
from whatever folder it names — the default, when the client sends none". That
is what stops one bad string turning into a meeting that can be recorded, typed
into, and never written out.

Client side there is no next folder. `MeetingRecord.destination` is fixed at
`start()` — deliberately, because a recording outlives the sheet that asked, and
rewriting it later would be the device claiming somebody chose something they
were never asked about — and `retrySync` puts a parked record back in the queue
**unchanged**, which is also deliberate: retry means *try that again*, not *try
something else*. Nothing between them can hand the finalize a different folder,
and nothing offers the person one. So from the phone that meeting is still
unrecoverable: every press of Retry names the folder that was refused, and the
gateway releases a claim nobody comes back for.

Two ways out, and both are decisions rather than patches. Either the note screen
offers to re-point a parked meeting — a second place where a destination is
chosen, which is exactly what `useMeetingFlow` was written to avoid — or
`retrySync` clears the destination when the rejection was about the folder,
which makes Retry silently mean "into your inbox instead" and is the class of
silent redirection this whole seam exists to close. Neither is obviously right,
so neither is taken. The person's notes are on the device and are not lost; what
they cannot do is get them into the bucket without discarding and re-recording.

### The Mac app is signed by a workflow nobody's branch can start, and builds honestly unsigned until then

System audio is the reason a desktop app exists — the machine hears the meeting
so no bot has to join it — and macOS will not hand it to an app it has not
verified. That makes packaging load-bearing rather than a chore: a hardened
runtime, `com.apple.security.device.audio-input`, three `Info.plist` usage
strings, a Developer ID signature and a notarisation ticket. Without them the
app records the microphone, degrades out loud, and the far side of a call on
headphones is not in the transcript.

Three decisions, and the first is the one that could have gone the other way.

**It builds with no credentials at all.** The certificate and the App Store
Connect key do not exist yet and only the account holder can create them. A
pipeline that could not run until they did would be a pipeline nobody had ever
run, so the unsigned path is a first-class outcome: a real `.dmg`, a printed
warning saying it is unsigned and will get no system audio, and the same
dispatch signing the day five environment values appear. What that costs is that
"the build worked" is a weaker statement than it sounds, which is why the
workflow says which kind of build it made rather than leaving it to be
discovered on somebody's Mac.

**`workflow_dispatch` only.** Merging deploys the Convex functions, the gateway
and an OTA bundle, because those are reversible by the next merge. A binary
somebody downloads and installs is not, and CLAUDE.md already names "a native
build" as what a merge cannot do on its own. `deploy-mobile-native.yml` set the
precedent and this follows it, including the consequence: **merging a desktop
change ships nothing** until somebody dispatches.

**electron-builder rather than Forge**, because the whole job is signing,
entitlements, notarisation and a dmg, and that is one file rather than a plugin
per step. `@supa-media/desktop` (supa-framework#56) is not published, so
upstream-first is a direction rather than an option today; the config is small
so adopting it later is a deletion.

A "simplification" that dropped `entitlementsInherit` would leave the renderer
that holds the microphone without the entitlement while the app kept it — a
build that signs, notarises, opens, and records silence. The checks are in
`apps/desktop/test/packaging.test.mjs`, and the sabotage record there includes
the one that matters most: the first version of those checks read the
entitlements file as text, so deleting the entitlement left them green because
the file's own header discusses it.

**The notarisation hook's *failing* path is checked too, and it is the other
half of "all three or none".** A skip when there is nothing to notarise with is
the friendly half; the load-bearing half is that a submission Apple *refuses*
fails the build, because a `catch` added later "to be resilient" produces a
green run and a dmg Gatekeeper rejects and macOS grants no microphone to —
which is the same silent-success outcome every other check here exists to stop,
arriving through a different door. And the `ASC_API_KEY_P8` private key the hook
must write to disk for `notarytool` is checked as *gone afterwards on the failing
path*, since a failed submission is exactly where a `finally` gets dropped:
`A NOTARISATION APPLE REFUSED FAILS THE BUILD` and
`THE PRIVATE KEY IS GONE AFTER A FAILED SUBMISSION`, both driven against a fake
Apple.

### What is deliberately not built

Not built, and none of them foreclosed:

- **Storing audio.** No recordings in the bucket, no recordings with us. The
  moment audio is retained, the product's promise needs a retention policy, a
  deletion path and a legal posture, and the thing being kept is the most
  sensitive artifact in the system.
- **A meetings database.** Recent-meeting lists, counts and calendars are derived
  from notes, like search is derived from files ([search](./search.md)). A
  meetings table would be the second copy that non-negotiable 3 exists to
  prevent, and it would be the copy the privacy engine does not guard.
- **Recording on behalf of someone who is not there.** See *nothing joins the
  call*.
- **Cross-context meeting search ranking.** A shared workspace's meetings are
  reachable exactly the way its notes are, through `context: "@name"`, and that
  is all.

### Consent is the customer's, and the product may never make recording invisible

The one decision here with no mechanical test, stated anyway because leaving it
implicit is how it gets designed away.

Recording law varies by jurisdiction and by who is in the room, and this product
does not know either. It does not announce itself to a call it never joins, and
it will not pretend to have handled a consent question it cannot see. What it
**must** do is make recording obvious to the person doing it: a Live Activity on
the phone, a tray indicator on the desktop, a visible timer, and an end control
that is one tap from wherever they are looking. A recorder with no visible state
is a surveillance tool that happens to have a friendly settings page.

The nearest thing to a test is that a session in `recording` always has a
surface: `a recording session with no visible indicator is a bug, not a mode`.
Detection may *suggest*, and the suggestion is a prompt with a "not now" — a
detector that silently starts recording would be the same product with the
indicator removed.

The first native release's Pause, Resume and End controls are authenticated
deep links into the app, not commands executed by the widget extension: a tap
opens Context and may require the phone to be unlocked before the JavaScript
recorder can act. Each rendered state carries a fresh 256-bit, one-use control
capability; the app requires the current live meeting and consumes that token
before touching audio, so a guessed or replayed `context://` URL is inert.
Direct locked-screen execution is deferred until recorder ownership can move
out of JavaScript without making Resume unreliable.

**"Wherever they are looking" is mounted once, at the root of the app — and so
is everything the recording depends on.** The phone's bar lived inside the
meetings navigator, which made it visible on the
meetings screens and nowhere else — so a person who started a recording and went
to read a note had a microphone open and no indicator, which is precisely the
mode this section says is a bug. It is now mounted beside the `(app)` stack,
above every route; it costs that layout nothing, because the recording lives in
a module-level store rather than a provider and the bar draws nothing when
nothing is live.

Two things follow, and both were found by checking rather than assuming. It is
mounted in **one** place — mounting it in the section layout as well draws two
bars over each other, because that layout renders inside this one. And it
**stacks above whatever floating chrome the screen underneath already has**: the
console's toolbar is a pill of the same height in the same slot, and a recording
bar lying on top of it would take a screen's navigation away for the length of a
meeting. The frame publishes the height it occupies and the bar clears it, which
is also why a screen with no chrome there pays nothing for the possibility.

The half that took longer to see is that **a recording visible from anywhere has
to be *working* from anywhere**, and two of the parts it depends on were still
wired to the navigator that unmounts. The Convex client the recorders ship
chunks through was installed by the meetings layout, so leaving the section
mid-meeting recorded audio, encoded it, deleted it and threw it away while the
bar went on drawing a live timer. And the recorder itself was built inside that
layout's effect, so coming back handed the controller a fresh idle one — End
then stopped that, while the object actually holding the microphone kept its
rotation timer and its listeners forever. A recording outlives those screens, so
anything it depends on is mounted where the bar is, or held across a
reconfiguration.

The checks are `the persistent recording bar is mounted here, and draws nothing
when idle`, `the frame publishes the height of its floating toolbar, and takes
it back`, `with the console's toolbar underneath, it clears it rather than
covering it`, `leaving the meetings section does not switch transcription off`,
and `re-configuring mid-meeting keeps the recorder that is holding the
microphone`.

### The way in is on the surface each density has, and it navigates rather than records

Everything above is about a recording that is already running. **Nothing in the
app started one.** `/meetings` had a list screen, a live screen and a working
recorder, and no `href`, no `router.push`, no button and no rail entry anywhere
outside `features/meetings/` reached any of it. Asked "how do I record a
meeting?" from a note screen, the honest answer was "type the URL". A feature
nobody can reach is not shipped, and this is the class of defect that hides
best: every unit test of it passes.

**It is a pinned row at the head of the console's rail, and — since the phone
lost its left panel — the last key on the phone's bottom row.** The settings
pane is still refused by its own file: its *This context, from further out* card
is explicitly for things that are **not** "a place you navigate to in order to
read a note", which a meeting screen is.

**The bottom toolbar's refusal expired, and the arithmetic that carried it is
corrected here rather than dropped.** This paragraph used to say that the rail
was the answer "at every density", quoting `AppFrame` on that slot being
"reachable at every density — a column on a pointer layout, a sheet the top bar
brings in on a phone", and it refused the toolbar twice: once on its own rule
that "navigation is not its job", and once on room — "at 390pt the pill is 286
wide, 262 inside its padding, which six targets already divide into 43.7pt
against a 44pt floor". Both halves have moved, and neither moved because
somebody wanted this entry on the bar:

- A phone has **no rail at all** now ([app-and-console](./app-and-console.md);
  `features/app/frame.ts`), so "at every density" is false about the rail and
  the premise under the `AppFrame` quotation — reachable through this node and
  no other — went with the panels.
- `layout.bottomBarInset` went **52 → 24** in the same change, which is what the
  seventh key was bought with. The 286 above is `390 − 2 × 52`; the pill is
  `390 − 2 × 24 = 342` wide now, 318 inside `bottomBarPad`, **317 once the
  separator has taken its point** — it is a `flexShrink: 0` child of the same
  flex row, so it is subtracted from what the targets divide rather than painted
  over them — and **seven targets are 45.29pt** against the same 44pt floor,
  where at 52 seven were 37.29 and even six were 43.5, under it. So a seventh
  did not fit and does.

  Every number in that sentence used to be the one before the separator (45.4,
  37.4, 43.7). The correction was made in `tokens.ts` and `BottomBar.tsx` and
  did not reach here; see `bottomBarGeometry`, which subtracts the rule
  explicitly so that no prose has to remember to.

`BottomBar` amended its own rule in that change too, and narrowly: it carries
exactly **one** destination, in the last position, behind a separator that keeps
the six note verbs reading as a group. It does not carry the contexts — those
are a list that grows, and a list belongs on the strip that scrolls. One
destination on the surface each density actually has is not two entry points to
maintain; it is the same entry on the two different bars a phone and a desktop
have.

This is not the `App` group returning ([app-and-console](./app-and-console.md),
*The rail is one list*). That group held Map and Connections — facts *about a
context*, which is why they moved into that context's settings — and it was
headed APP over YOURS over SHARED WITH YOU, which is what made the rail read as
a second, unrelated left navigation. One pinned row with no heading is not a
second panel.

**Pinned, and at the head of the rail rather than beside sign-out**, and the
second half of that is about the bar rather than about taste. Whenever the
frame's bottom toolbar is not showing it publishes a chrome height of zero, so
the recording bar drops to `floatingStackBottom(insets.bottom, 0)` and lies
across the bottom ~100pt of whatever is under it. A destination the recording it
leads to can cover is not a destination. (The same arithmetic puts that bar over
the account block, which is a pre-existing hole in *sign-out* and is not fixed
here.)

**The trigger for that is not what this paragraph used to name.** It said "while
a panel is over the editor", because `toolbarHidden` was `accessoryOpen ||
regions.scrim` and the scrim was a phone's drawer. There is no scrim at any
density now ([app-and-console](./app-and-console.md)), so the surviving trigger
is the keyboard accessory bar — which is the more common one anyway, and the
conclusion is unchanged.

**And it navigates. It does not record.** *Consent is the customer's* says a
detector that silently started recording "would be the same product with the
indicator removed"; a control that opened the microphone is exactly that, one
surface over. The record button lives where the disclosure can be given beside
it — on `/meetings`, next to the sentence saying where the audio goes and what
is kept — which a row in a navigation panel cannot do. The mark is a microphone
on a cradle rather than the recording bar's waveform or the list's red disc, so
no glyph in the product means both "a meeting is being recorded right now" and
"meetings live here".

**Both halves of that need amending for the phone's key, and the amendment is
narrower than it looks.** The seventh key does not navigate to `/meetings` and
it does not start recording either: it raises a sheet that asks *where this
meeting is going* — `MeetingDestination`, a context and a folder — and recording
begins only after somebody has answered. So the disclosure is not left behind on
a screen the key skipped; it is on the sheet the key opens, which is the surface
the decision asks for.

**The property that holds is "no press without the disclosure beside it", and
this paragraph used to state a stronger one that is false.** It said *no single
press anywhere in this product opens the microphone* — two sentences after
describing the press that does. `/meetings`' red disc is `onRecord →
controller.start → recorder.start()`, one press, no dialog, and that screen's
own header says so in as many words: "it starts a meeting with no dialog in
front of it: the reference experience is that you open the app and hit record".
That is a deliberate decision, not an oversight, and it is exactly why the
weaker claim is the true one: the disc sits on the screen that carries the
sentence about where the audio goes and what is kept, so the disclosure is
*there*, in front of the person, rather than behind a dialog. The rail row and
the seventh key cannot make that claim from where they sit, which is why neither
of them records.

A way in also needs a way back, and `/meetings` had none: the list screen sits
outside the console, nothing above it draws chrome, and the live and note
screens each carried their own back control while the list carried nothing. It
does now, and it falls back to the console when there is no history behind it —
a cold start on a typed URL or a reload on the web, where `router.back()` is a
press that does nothing.

The checks are `the rail carries it at full / icons` — `sheet` was in that
enumeration and left it, because `regionsFor` cannot return it at any density
and a test over a mode nobody can reach is the opposite of what enumerating them
is for —
`the collapsed rail keeps the name it cannot draw`,
`a rail with nowhere to send anybody draws no entry`,
`the route it names is a route this app actually has`,
`the console layout hands the rail somewhere to send them`,
`pressing it opens no microphone and writes no session`,
`the entry is at the head of the rail and the bar is against the glass`,
`the list goes back the way somebody came`, and
`and to the console when there is no back`. The placement check is the one worth
knowing about: its first version read the children of the head's *own parent*,
which travels with the block, so moving the entry down beside sign-out passed
every test in the file. It is anchored on the rail's root now.

**And then a phone lost the rail, and this section's answer went with it.** The
paragraphs above are correct about the seventh key, and the seventh key starts a
*new* meeting: it raises the destination sheet. Nothing else on a phone reached
`/meetings`. The recording bar returns you only to a *live* meeting, the rail's
`onOpenMeetings` was the only navigation to that list in the app, and
`regionsFor` answers `rail: "hidden"` at compact. So a **finished** meeting was
unreachable on the density that records them — flagged in review before the
merge and merged anyway — and a person recorded a meeting on their phone, ended
it, and had no route to it: *"the note sort of just disappeared… I don't know if
it succeeded, if it failed. Just nothing at all."*

Three things close it, and they are not three versions of one fix. The first two
were both needed, and the third is the one the person actually reached for.

**The way to the list is a row on the destination sheet**, beside the heading
and above the fork, offered whether or not the viewer owns a workspace to record
into. The alternatives were weighed and each cost something this one does not:
an eighth key does not fit (`bottomBarGeometry`, seven targets at 45.29pt
against a 44pt floor, verified to 309pt), and a menu on the pinned account mark
puts the only sign-out a phone has one press further away — the one control
`ConsoleRail` says somebody "reaches for deliberately and must not miss". A
long press on the microphone was refused outright as a *first* route: an
invisible gesture is not discoverability, which is the failure being closed. So
the meetings key opens the meetings surface, and both of the things a person
does with meetings are on it.

**Ending a meeting navigates to it.** `controller.end` touches no router and
should not — the controller owns no navigation — but nothing else did either, so
End on the persistent bar left somebody standing on whatever screen they were
reading. The bar now lands them on the meeting, after the end resolves so
`/meetings/:id` draws the note screen rather than flashing the live one, and not
at all when that meeting is already underneath. This is stronger than any list
entry: the thing they just made is in front of them, and it *says what state it
is in* — `MeetingNoteScreen` draws "Not in your bucket yet" whenever `notePath`
is `null`, which was the ordinary outcome for as long as
nothing here could reach the bucket and is now the outcome for a meeting the
queue has not landed, and it never draws a tick over a note nobody wrote. That half was
already right and now has a test driven through a gateway that will not answer.

**And a meeting can be got off the device.** The sharpest need turned out to be
neither of the above: the owner found their recording, it was intact, the screen
correctly said it had not left the device — and that was everything the screen
could do. No copy, no share, no export, and no route to the bucket, because the
credential is unwired. A meeting somebody can see and cannot use is the data-loss
experience with no data lost. So the note screen has **Copy note**, and what
lands on the clipboard is `renderMeetingNote(session)` — the gateway's own
renderer, imported through one crossing point (`features/meetings/note.ts`, on
`protocol.ts`'s rule) — so what gets pasted into a vault is the file the customer
would have had, frontmatter included. A screen-shaped summary would be a second
answer to what a meeting note is, drifting from the one in the bucket, over a
format that is stable by non-negotiable 3. It is drawn in every state, because
the meeting that reached the bucket can be opened from five other places and the
one that has not cannot be opened from any. And it never claims a copy it did not
make: `writeClipboard` answers a boolean, both outcomes are said on the screen,
and neither fades — a failure that cleared itself after a second and a half
would be the silence this whole seam is about.

The checks are `a phone can reach its meetings from the key it records with`,
`and can reach them without owning a workspace to record into`,
`pressing End lands on the meeting that just ended`,
`and does not push a second copy of a screen you are already on`,
`and that meeting says plainly it has not reached the bucket`,
`what lands on the clipboard is the note the gateway would have written`,
`a clipboard that refuses is said, not papered over`, and
`the way out is there for the meeting that has not left the device`. The class
this belongs to has its own guard —
[app-and-console](./app-and-console.md), *a route with no way in is a route
nobody has*.

**And the seventh key is the phone's only microphone, because a second one grew
beside it.** Dictation shipped as a floating control at the bottom-right of the
note region (`features/voice/VoiceButton.tsx`), and on a 390pt screen it landed
24pt above this key: the same `mic` glyph twice, raising two different sheets —
one asking *dictate or record*, one asking *where does this meeting go*. The
owner's whole report was four words: *"why are there 2 microphones?"*

The floating one yields, and it yields to the key rather than the other way
round because that direction was already decided above: this key is the phone's
only way into meeting capture, and the only route to a **finished** meeting
hangs off the sheet it raises — a route that exists because somebody recorded a
meeting on their phone and could not find it again. Keeping a floating button
by deleting the key would re-open that hole to close a smaller one.

`VoiceButton` already held the rule and applied it to one case only — *"there is
a single microphone on this machine and the meeting has it"*, which is why it
draws nothing while a recording runs. A control on the glass that opens a
microphone is the same case with nothing running, so the yield now covers both.
What it does not cover is a microphone that is already **open**: the live
capsule is the only way to stop a run and take back what it typed, and the
failure card is a sentence owed to whoever opened one. Both are drawn whatever
the toolbar is doing.

**Dictation is not lost on a phone by this, it is offered later and better
placed.** The frame hides its toolbar while the keyboard accessory bar is up
(`AppFrame`'s `toolbarHidden`), so the floating microphone returns at exactly
the moment there is a caret for words to land at. On a native build there is no
browser engine to open at all, and the sheet has always said so in as many words
— *"Your keyboard already has a microphone key, and it types straight into the
note"* (`engine.ts`) — so what this yields on iOS and Android is a button whose
only live row was the meeting the key beside it already raised.

The checks are `a phone with a note open draws one microphone, on the bottom
row`, `the keyboard takes the bottom row away, so the microphone comes back`,
and — since the console's corner became a `+`, see *A meeting opens in the
panel* below — `the corner is the + now, so the editor draws no microphone at
rest` beside `...and a pointer surface with no + keeps it, because nothing
replaced it`. All of them driven
through the real editor in
`apps/mobile/__tests__/oneMicrophone.test.ts`, because the condition has two
halves and no unit test of either component can see them together.

### The press records, and the indicator is the disclosure (2026-09-19)

**This reverses *"it navigates. It does not record"* and half of the section
above it, at the owner's instruction, and the reversal is narrower than it
sounds.** The rule was that no control anywhere may open a microphone without
the sentence about the audio beside it, which the phone's seventh key satisfied
by raising a destination sheet: two rows naming a context and a folder, an
audience line on each, the audio sentence, and a Start beside it. Every meeting
anybody has ever recorded in this product went through that sheet.

The owner used it and removed it: *"all meetings from now on should go into
0-inbox/meetings, no need to ask people it will just confuse them"*, and, of
the sentence that remained on the running meeting's card, *"we dont need all
these extra details"*. So:

- **Pressing New meeting starts recording.** No sheet, no destination question,
  no Start. `useMeetingFlow.startMeetingFlow` opens the microphone.
- **The destination is a rule, not a choice**: the person's own inbox —
  `0-inbox/meetings`, or whatever folder they have set for their own context
  (`automaticDestination`). Filing afterwards is what an inbox is for.
- **The audio sentence is said once**, at first run and in the meetings settings
  pane (`features/meetings/disclosure.ts`), rather than in front of every
  conversation.

**What *Consent is the customer's* actually protects is untouched, and it was
never the question.** That section's test is "a session in `recording` always
has a surface", and the surfaces got *better* rather than thinner: on a console
the right panel opens on the running meeting with a red mark, a clock, a live
meter, the path the note is going to, a name field and the two controls that end
it; fold that panel and the clock moves into the title bar
(`ConsoleLiveMeeting`); on a phone the press lands on the meeting's own screen,
which is all of the above plus the notepad. What was removed is a *modal in
front of* the indicator, not the indicator.

**The privacy half of the destination sheet is kept, and with the sheet gone it
matters more rather than less.** `destination.ts` argued that a meeting recorded
while reading something in a shared workspace must not land in that workspace,
visible to everyone in it, before the person has read a word of the transcript —
and that was a rule with a sheet, an audience line and a row in front of it.
There is nothing in front of it now, so the rule is absolute: the destination is
`ownPersonalContext`'s inbox, wherever the person is standing, exactly as
`meetingWorkspaceId` already answered for a meeting nobody addressed. The check
is `a meeting recorded in a shared workspace still lands in your own inbox`, and
its pure half is `standing in a shared workspace does not put the meeting in it`.

**The whole-call switch outlived the sheet on purpose.** It was a row on it, and
in a browser it is the only way to take the far side of a call — `getDisplayMedia`
costs a source picker, so it cannot be a default and would have been deleted
along with the sheet. It is a per-device setting now
(`features/meetings/machineAudio.ts`), set in the meetings pane and read at the
press; the defaults are the sheet's own, on where a shell can tap silently, off
where a picker would appear in front of every in-person meeting.

**Two presses can still be refused, and both say so.** A device whose controller
has not been pointed at a context yet, and somebody who owns no personal
workspace — offered their @name instead. `MeetingRefusal` is what is left of the
sheet, and it exists because a control that quietly does nothing is the defect
this feature has closed at every layer.

**The phone's route to its finished meetings moved with the sheet it hung off.**
"Past meetings" was a row on the destination sheet; the key records now, so the
row is on the account menu — the one menu a phone always has. The alternatives
are unchanged and still refused: an eighth key does not fit, and a long press is
not discoverability. `routeReachability.test.ts` holds it, and the region
`bottomBar` left its claimed-regions list in the same change, which is the guard
noticing that the sheet took a route with it.

The checks are `one press opens the microphone, with no sheet in the way`,
`a meeting recorded in a shared workspace still lands in your own inbox`,
`two presses in the same moment record one meeting`,
`pressing it again while one is running shows that one rather than starting a
second`, `a device with no context yet says so rather than throwing`,
`somebody who owns no workspace is offered their name, not a recording`,
`the machine's own audio follows the setting, not a question`, and, on the phone
itself, `the app's other place is the last key, and pressing it records`.

### A meeting opens in the panel, and the corner is a `+` (2026-09-19)

**A meeting was a page, and it should not have been.** `/meetings/:id` is a full
screen: opening a running meeting from the console replaced the note somebody
was reading, and getting back was a navigation. The owner's words are the whole
of the argument — *"meetings should stop opening up in the big ugly page and
only open up in the side panel"*.

So the console's right panel — which already held chat, and already held a
read-only card about a running meeting — is where a meeting lives now
(`features/console/aside/MeetingsTab.tsx`). The name, the clock, the meter,
where the note is going, a composer that stamps a typed line with the meeting's
own clock, and the controls that stop it. Nothing in the console navigates to
`/meetings/:id` any more; the route stays, because a phone has no panel and an
old link must not break.

**A finished meeting is a file, and the panel says so rather than editing it.**
Its summary, its notes and its path are shown, and the one action is *Open the
note* — into the editor behind the panel, which is where this product renames
and edits Markdown. A second, weaker editor in a 330pt column, writing to a
record whose note has already been filed, is how a rename ends up on a device
and never in the bucket.

**An explicit start takes the tab; a meeting merely starting still does not.**
`tabs.ts` refuses the seize because a panel that swaps out from under a composer
loses a half-typed question. Pressing New meeting *is* somebody asking, which is
the same trade the ⌘K handoff already makes in the other direction.

**The corner is a `+`.** It was a microphone, and it was drawn only over a live
editor — so it vanished on a folder page, on the map and on search: *"it should
show up all the time, even when on a folder page, and not just show up when on
a note"*. `CreateButton` is mounted by the console **layout** rather than by the
note editor, which is the whole of that fix, and it offers the three things
somebody starts from a console: a meeting, a note, a chat. Dictation is not a
fourth — it needs a caret, so it stays on the note's own context menu, and the
live capsule and failure card stay with `VoiceButton` because they are the only
way to stop a run.

**Two indicators in one corner is the defect this product keeps re-finding, so
the floating recording bar stands down while a console is carrying the
meeting** (`features/meetings/carried.ts`, the shape `bottomChrome.ts` already
uses). A phone-width console carries it nowhere, and the bar is still the whole
indicator there.

The checks are `and one opens in the panel rather than on a page`,
`its note opens in the editor behind the panel, which is where a file is
edited`, `a filed meeting offers no second editor of its own`,
`the + menu's New meeting opens the panel on Meetings`,
`and a meeting that merely starts still only marks the tab`,
`the corner is the + now, so the editor draws no microphone at rest`, and
`...and a pointer surface with no + keeps it, because nothing replaced it` —
the last one being the fixture and the demo console, which are desktop-width
consoles with no `+` in that corner at all.

### The phone has a meter, and it always did

**The claim that was never checked.** `capture/level.ts` argued that a level
does not belong on `MeetingRecorder`, and gave three reasons. The second was
that *"only one of the five recorders can produce one — the desktop shell holds
an `AnalyserNode` on the stream it is recording; the phone's `expo-audio` and
the browser's `MediaRecorder` do not"*.

Half of it was false. `expo-audio` meters on both phone platforms: iOS from
`AVAudioRecorder.averagePower`, Android by converting `MediaRecorder`'s
`maxAmplitude`, both answering in dBFS on `getStatus()`. It is behind one flag
— `isMeteringEnabled` — and nothing set it, so `useAudioLevel` answered `null`
on every phone and the mark beside the clock drew its static silhouette for the
length of every meeting.

**It cost the owner two evenings, for the reason `Waveform`'s own header
predicts.** That file records "a meter that responds to sound is a capability
claim" and the first evening it was written about: *"the bar is still not
moving. And I can't tell that it can hear me talking."* The fix then was to
animate the desktop meter, and the phone was left drawing the same unmoving
mark under the same claim. The second evening was the question that followed —
why is there a mark shaped like a meter that does not move — and the answer was
that nobody had asked the device.

**So the recorder reads its own meter and publishes it, and the conclusion
about the interface survives.** The channel is a module-level publisher in
`capture/level.ts`, not an event on `MeetingRecorder` and not a field on the
snapshot: the first reason in that header is intact and is the load-bearing
one — a level moves ten times a second, everything that reaches the controller
rebuilds the app's whole meetings snapshot, and six hundred rebuilds a minute
for a number one leaf reads is a cost for nothing. `notesOnly` still has no
input and a build with no shell still has no bridge, so an interface method
would still oblige implementations to answer a question they cannot. (A browser
was the third name on that list until the section below took it off.)

**The shell stays preferred where there is one.** A phone's meter is the
microphone; the shell's is the louder of the microphone and the machine's own
audio, which is the honest answer to "is this recording hearing anything" on a
call.

**The floor is a display decision, not the format's.** -160 dBFS is digital
silence, and a meter scaled across 160 dB leaves a human voice in the top
eighth of the bar and everything quieter flat — the unmoving mark again,
reached by arithmetic instead of by omission. `METER_FLOOR_DB` is -55, roughly
a quiet room on a phone microphone, which puts speech at arm's length in the
middle and upper half of the mark.

**`null` is still not zero**, and that is the rule the whole meter rests on:
`Waveform` draws a different mark for "nothing can tell you" than for
"listening, and the room is quiet". An absent `metering`, a `NaN`, and the
`-Infinity` Android's conversion produces for true silence are all published as
no reading rather than as a silent room.

The checks are `the recorder is asked for a meter, on both platforms`,
`what the microphone hears reaches the meter, as a fraction of the mark`,
`a recorder with no reading publishes \`null\`, never a silent room`,
`the meter goes quiet when the microphone does, rather than keeping its last
reading`, `decibels become a fraction of the mark, with a floor a voice sits
above`, `no reading is \`null\`, and never zero`, `with no shell, the
recorder's own readings reach the leaf`, and `the shell is preferred where
there is one, because it hears more`.

**Not proven here, and it is the same gap the section below has:** the meter is
driven from a fake device. That a phone's bar moves when somebody speaks needs
a native build and a voice.

### ...and so does a browser, which is the third surface that drew a claim it could not keep

Reported in the same breath as the headphones: *"the equalizer does not move on
web so it looks off."* The same defect as the phone's, one surface along, and
the section above predicted it — it listed a browser among the surfaces that
cannot answer "how loud is it", which was true of `MediaRecorder` and not true
of the page it runs in.

**`MediaRecorder` has no meter and Web Audio does.** An `AnalyserNode` over the
same inputs being recorded is what the shell has done since the meter landed;
there is nothing about it that needs a shell. So the browser recorder builds the
graph it was going to build anyway for mixing, hangs one analyser off every
input, and publishes RMS dBFS on the same module channel the phone polls, at the
same 10 Hz.

**One analyser fed by both inputs, rather than two and `loudest` over the pair.**
The bridge carries `{ mic, systemAudio }` because the shell genuinely knows both
and a diagnostics screen may one day want the split. Here the two inputs are
already being summed into one recording, and the question the mark answers —
*"can this hear anything"* — is a question about that recording.

**The mic-only path records exactly the bytes it always did.** The analyser is a
sink hanging off the side of the microphone's own stream; `MediaRecorder` is
handed the mixed destination only when there are genuinely two inputs to
combine. A meter is a decoration and may not change what lands in somebody's
bucket.

**`null` is still not zero, and digital silence is a reading.** A browser with
no `AudioContext` publishes nothing at all, which draws the static silhouette —
*"nothing here can tell you"*. A window of exact zeros is `20 * log10(0)`, which
is `-Infinity`, which `meterLevel` reads as no reading: it is returned as
`METER_FLOOR_DB` instead, because something genuinely is listening and the honest
answer is the bottom of the mark rather than the absence of one.

**A suspended `AudioContext` is checked rather than assumed away**, and that
guard is about the recording, not the meter: autoplay policy can hand back a
suspended context, and a suspended context's destination node produces a stream
of silence — a meeting that records perfectly and contains nothing. It is
resumed, and a context that will not run is closed and answered as `null`, so
capture falls back to the microphone's own stream.

The checks are `a browser with no AudioContext publishes nothing at all`, `a
room with a voice in it moves the mark`, `a quiet room reads zero, which is not
the same as no meter`, `a meeting that ends says it has no reading rather than
keeping its last`, `a paused meeting is not listening, and the meter says so`,
`the shared source is in the reading, not just the microphone`, and `a browser
that cannot mix records the microphone and says so`.

**Not proven here, and it is the same gap the section above has:** the analyser
is a fake. That a real bar moves when somebody speaks into a real microphone
needs a browser and a voice.

### Ending a meeting is not waiting for it to be transcribed

The lock-screen fix worked and arrived with two defects of its own, reported
together: *"the post process is a little slow, and it keeps recording while
it's processing… the countdown doesn't stop."* Both were one line.

**`stop()` did too much.** It stopped the device, cut the remaining audio out of
the file, and then waited for every outstanding transcription. The comment on
that last wait said it "costs a spinner rather than a microphone", which had
been true of the rotating recorder and was not true of this one: on the
continuous path the device is released *after* `closeChunk`, and `closeChunk`
is where the waiting moved to. So the input stayed open for the length of the
drain, on a meeting somebody had finished.

It was also a tail-chase. The slicer cuts what is on the file, and a recorder
that is still running adds another 32 KB a second — so each pass found the
audio recorded during the previous pass's wait, and the drain converged only
because sending happens to be faster than recording.

**And `controller.end()` cannot fold the `end` event until `stop()` resolves.**
So the session stayed `recording` for the whole of it: the live screen, the
running clock, the microphone chip, over a meeting that was over.

Three changes, in the order they matter:

 - **The device is stopped before a byte is taken.** The input goes back at the
   moment End is pressed, and the file is a fixed size, so what is left to cut
   is bounded by what the ticks had not already taken.
 - **`sliceAll` ends when the file is fully cut, not when the queue is empty.**
   "The audio is off the device" and "the meeting has been transcribed" are
   different questions and only the first is that function's. It still waits
   when the send queue is full, because that is what bounds how much of a
   backlog is cut into memory at once.
 - **`stop()` and `drain()` are separate.** `stop()` resolves with the
   microphone back and the audio queued; `drain()` waits for the words. The
   controller ends the meeting between them.

**The wait is kept, and keeping it is the point.** The finalize composes the
note from the transcript the session holds, so a segment arriving after it is a
note missing the end of the meeting — usually the decision. What changed is
where it falls: after the fold, behind `MeetingNoteScreen`, instead of in front
of a screen still claiming to record.

**Which exposed a sentence that was true and unhelpful.** That screen had one
line for a meeting with no note yet — *"Waiting to reach your context"* — and it
now had a visible window in which the honest answer was different: nothing is
wrong with the connection, the last of the audio is still being turned into
words, and the finalize is held on purpose until it is. `snapshot.transcribing`
carries that, beside `ending` and for the same reason. Telling somebody about a
network problem they do not have is the same defect as telling them nothing,
one sentence further on.

The checks are `the microphone is back before anything is waited for` — which
asserts the *order* against the recorder's own log, because "the microphone is
back" is true of the broken version too and only "before the first byte was
sent" is not — `ending does not wait for the transcript, and \`drain\` does`,
and `the clock stops when the microphone does, not when the transcript lands`.

**What none of this makes faster.** The transcription takes as long as it takes:
a round trip per slice, through Convex to a Whisper worker, bounded at three in
flight. This change is about what the person is looking at while it happens and
about not holding a microphone through it. If the wait itself needs to shrink,
that is the chunk size, the concurrency, or the engine — and it is a different
decision.

### One recording per meeting, because iOS will not let a locked phone start a second one

**The defect.** A meeting recorded on an unlocked phone was fine. The same
meeting with the screen off produced a transcript that stopped a few minutes in
and no error anywhere — the owner's was 03:01 long, out of a meeting that was
not.

Everything anybody would check was already right. `UIBackgroundModes: ["audio"]`
was in the binary, `allowsBackgroundRecording: true` was in the audio session,
and a native build carrying both had shipped. The entitlement was never the
problem, and neither were JavaScript timers, which is where this was first
looked for.

**The cause is that a rotation is a `record()`.** Capture rotated chunks by
stopping the recorder every twenty seconds and starting a new one, and iOS
refuses to *start* a recording from the background —
`AVAudioSessionErrorCodeCannotStartRecording`, a privacy restriction since
iOS 12.4. The exemption is narrow and is exactly the wrong shape for a rotation:
a recording that is **already running** when the app is backgrounded may carry
on, and one that is not may not begin. So every twenty seconds the app gave up
the one thing a backgrounded recorder is allowed to keep and then asked for it
back. In the foreground, granted. Locked, refused, and the meeting was over.

**So the device is started once and the chunks come out of the file.**
`record()` is called by `start`, by `resume` and by the interruption recovery,
all of which are either in front of the person or already failing. The rotation
tick touches the device not at all: it reads what the recorder has written since
last time, cuts it on a sample boundary, wraps it in a WAVE header and sends it.
This is what the meeting recorders that survive a lock screen do.

**That forces linear PCM, and the cost is disk.** A growing `.m4a` cannot be
read — AAC in an MPEG-4 container is not valid until `stop()` writes the `moov`
atom, so a prefix of one is not a shorter recording, it is not a recording. A
WAVE file writes its header up front and appends samples, so the bytes on disk
at any moment are the audio so far. 16 kHz mono 16-bit costs about 115 MB an
hour against roughly 8 MB for AAC, in a cache directory, for the length of one
meeting — and 16 kHz mono is the transcription model's own input, so nothing
downstream resamples.

**iOS only.** Android's `MediaRecorder` has no linear-PCM output and does not
have the disease: its foreground service keeps the process scheduled, so the
rotation goes on working there. Rotation is therefore kept rather than ported,
and the tests that were written for it now run against the platform that runs it.

**Nothing trusts the options it asked for.** `parseWavHeader` reads the format
out of the file the device actually produced. A device may substitute a sample
rate, and a slice labelled 16 kHz that is really 44.1 kHz transcribes as
nonsense at a third speed — which reads as a broken model rather than a broken
header, and is the most expensive kind of wrong. The header is also not
assumed to be 44 bytes: WAVE permits chunks before `data`, and slicing from a
constant would feed header bytes into the transcript.

**Two smaller things fell out of it, both of which were latent.** The recorder
was being constructed with a *nested* `RecordingPresets` object, and the native
side decodes one flat record — so everything under `ios:` had always been
dropped in silence. It cost nothing while the answer was AAC either way, and it
would have cost the whole change here, because `outputFormat` is the field that
selects linear PCM. And a backed-up send queue no longer drops audio: the file
is the buffer, so the slicer simply does not advance and the next tick takes the
same bytes — where a rotation had to drop, because the file it held was about to
be deleted.

The checks are `the microphone is started once, however long the meeting runs`,
`the recorder is asked for linear PCM, in the flat record the native side
reads`, `the slices are the recording, in order, with nothing dropped or
repeated`, `a slice is as long as the audio it holds, not as long as the tick
was`, `a backed-up queue leaves the audio on disk instead of dropping it`,
`ending sends everything still on disk before the microphone goes back`,
`pausing puts the microphone back, and resuming does not re-send what it heard`,
`the file it is recording into is not left open once per tick`, and the whole of
`__tests__/meetingsWav.test.ts`, whose round trip is the one that catches what
the individual assertions let through.

**What is still not proven here.** Every check above runs against a fake device
and a fake file system. That a locked iPhone now records for the length of a
meeting is the claim this change is *for*, and it cannot be made by this suite —
it needs a native build and a phone with its screen off. Until somebody has run
that, the honest statement is that the call iOS refuses is no longer made.

### A meeting is written the way a note is, because that is what it is

**The root cause of the vanished recording, and it is not what the sections
above assumed.** They say the gateway credential is "the one unfinished seam in
this feature" and that a meeting kept on the device is an absent capability
reported honestly. The first half is true and the second half was a rationalised
hole: the app could not reach the gateway, so **every meeting recorded,
transcribed, and stopped**. In the owner's words: *"doing a meeting should be
the exact same thing as creating a new note, except there's dictation
involved."*

The gateway authenticates MCP clients by per-client OAuth grant
([identity-and-access](./identity-and-access.md), non-negotiable 4). This app is
not one of those clients; it signs in to the control plane with
`@convex-dev/auth`. What it *has* been doing all along is writing notes into the
same customer's bucket on every save the editor makes, through
`files.writeNote` → `fileOps.writeFile`. A meeting now takes that path.

**Two writers, and which one an app uses is a property of its credential.**
`createHttpGateway` is not deleted and is not deprecated: it is the right answer
for a client that holds a grant — the desktop app, where the gateway's
enhancement pass, its session records under `.meetings/`, and `list_meetings`
live. `createConvexGateway` is the right answer for a client that holds a
control-plane session. `useMeetingsSetup` is the single line in the feature that
knows there are two, and every screen, the controller and the queue still take
`MeetingsGateway` and nothing else.

`finalize` takes the **session** rather than its id, and that is forced rather
than tidy: the Convex writer *composes* the note, and it cannot hold a session
from an earlier step because `pendingSteps` skips `session` once the metadata is
acknowledged — so a retry after a restart reaches finalize with nothing behind
it. The HTTP gateway reads `session.id` and ignores the rest.

**Idempotency is bought twice over, because a second writer loses it first.**
The gateway claims a path into the session record before writing; there is no
session record on this path. Instead: `meetingNotePath` ends the key with the
tail of the meeting's id, so the same meeting composes the same key every time
and two meetings never collide; and `writeNote` with no `expectedEtag` is
**create-only** — `writeFile` refuses with `CONFLICT` rather than overwriting —
so a retry after a write whose answer was lost is refused, and a `CONFLICT` at a
key ending in this meeting's id is read as this meeting's note and answered with
its path, never clobbered.

**That last reading is a bet on the key's shape, and the gateway's own author
considered it and declined to make it.** `unclaimedNotePath` in `ingest.js` says
a collision is either this session's retry or *"a note somebody else's tooling
put there"*, and it tells them apart **by the claim record** — suffixing rather
than answering, because a gateway that overwrites an unrelated note "has
destroyed something no version history of ours can give back". With no claim
record this path cannot make that distinction. What bounds it is that it never
writes: the bad case is answering with a path that holds somebody else's note,
not destroying one.

**Two residuals, because the key is `(workspaceId, path)` and this document
named one of them and called it the residual.**

 - **The path** carries the title's slug, so a rename between a lost answer and
   a retry composes a second key. **The app offers a rename now, and the bound
   moved from "nobody can" to "not from inside the window".**

   Twice-wrong history, kept because it is the reasoning a reader repeats: this
   first said the title was editable on `LiveMeetingScreen` and the residual
   live, which was false — that screen rendered static text and
   `controller.setTitle` had no callers, so the guarantee was safer than claimed
   and argued from a surface that did not exist. It then said nothing in the app
   offers one, which was true until `MeetingTitleField` existed.

   The window opens at the **first finalize**. `MeetingTitleField` is drawn only
   on `LiveMeetingScreen`; `[id].tsx` draws that screen for exactly `recording`
   and `paused`; and the move out of both is `end()`, which queues the finalize.
   A renameable session has therefore never been finalized. The one transition
   that could put a renameable session back inside the window is
   `finalizing -> recording`, which `MEETING_TRANSITIONS` allows and nothing in
   this app makes — `start()` mints a fresh id and is the only caller of the
   `start` event. Breaking the bound means adding a rename to
   `MeetingNoteScreen`, or a route back from `finalizing` to `recording`.
 - **The workspace.** `resolveWorkspaceId` reads a ref re-assigned on every
   render, so a retry taken after the workspace list moved underneath resolves
   somewhere else — and a create in a *different* bucket meets no conflict to
   catch it. Two notes, one meeting. Bounded by the answer being
   `ownPersonalContext`, which changes at most once per account, and by a named
   destination resolving by slug.

Either would need the claim the gateway has.

**The tier rule is not bypassed; it is the same machinery, more directly.**
`writeNote` authorizes through `authorizeFileAccess` at `editor` and
`writeFile` then refuses any path the caller's own scope cannot see, through
`canSee` over that context's `privacy.md`. *A meeting note is a note, and
`privacy.md` decides it with no bypass* is held by the same function every note
save goes through rather than by a second implementation of the same idea. The
premise is pinned by reading the control plane's source from the app's suite,
the way `storageCodePosition.test.ts` does.

**What this path gives up, stated rather than glossed.** No enhancement pass, so
`## Summary` carries `note.js`'s own `_No summary yet._` until somebody wires
one — the regenerable half, by *the human's words are never rewritten*, and the
notes and transcript are the half that is not. No session record in the bucket,
so a meeting in progress is not visible from a second device. No `list()`, which
nothing in the app calls because `/meetings` is per-device by design. The
destination work is untouched: the sheet's answer is still where the note goes,
a folder that will not file falls back rather than losing the meeting, and
`folderRejected` still reaches the screen.

The checks are `finalizing writes one note, through \`files.writeNote\``,
`what it writes is the note the gateway would have written`,
`the folder the sheet chose is where the note goes`,
`the same meeting composes the same key every time`,
`a retry after a lost answer finds its note rather than writing a second`,
`the write is create-only, so it can never clobber a note`,
`a context this device cannot reach yet is retried, not parked`, and
`the action a meeting writes through is the one every note save uses`.

### The notepad holds the keyboard open, so the transport rides it

`NotesPad` autofocuses — it is the screen — so on a phone the soft keyboard is
up from the first second of a recording and stays up, and both native platforms
draw it *over* the app. The transport sat at the bottom of the glass, behind it,
which made End unreachable: *"I had to like leave and go to another page"* to
end a meeting. A recording somebody cannot stop from where they are is the same
family of defect as a meeting they cannot find, and it is worse, because the
microphone is still open while they look for the exit.

The transport is inside `KeyboardSticky` — the pair that already existed for
exactly this, and which `NoteAccessory` has used since `b23ac96`; the claim that
it "had no callers" was wrong, and the caller it had is the one whose geometry
is right — with a spacer holding its place in the flow so the chips above it are
never drawn underneath. The leading key on it puts the keyboard away, which the
note editor has had on its accessory bar and this screen had nowhere. Leading
rather than trailing, so a thumb reaching for the End it knows does not find a
new control under it — and it does not end the meeting, which is the shortcut a
key beside End must never take.

**Riding the keyboard is half of it, and shipping only that half made the screen
worse in the other direction.** A bar lifted by the keyboard's full height lands
*inside* what the keyboard was covering. `NotesPad` is `flex: 1` in a
non-scrolling `Screen` with nothing avoiding the keyboard, so its frame ran
behind the keyboard and did not shrink, and an opaque 66pt control sat in the
middle of the visible text: about ten lines in, the caret went under it. End was
reachable and the thing it was there to protect was not. The screen gives the
keyboard its room through `Screen`'s own `chrome` prop, so the content box ends
where the keyboard begins and the spacer — the last thing in that box — is where
the lifted bar lands. `useKeyboardHeight` is the height, and it is `0` on the
web because the browser has already reflowed the document into what is left.

`KeyboardSticky` anchors at `bottom: 0` and has no offset on purpose, so two
numbers are the caller's and this screen paid neither: an absolutely-positioned
child lays out against its parent's *padding box*, so the safe-area
`paddingBottom` did not hold the bar back and it sat in the home-indicator band
— `RecordingBar`'s own rule inverted — and it needed a `zIndex`, being drawn
over the chips. `NoteAccessory` sets both.

**And `RecordingBar` drew a second copy of the same three controls on top of
it.** The bar is mounted above every route including the live meeting's own,
where it floats in the same 66pt of glass at the same inset, in a different
stacking context so `zIndex` cannot arbitrate. It draws nothing there now, which
is what the bar is for: reaching a meeting you are *not* looking at.

The checks are `the transport rides above the keyboard, so End is always
reachable`, `the transport is inset clear of the home indicator, and drawn over
the chips`, `the notepad gives the keyboard its room, so the lifted bar lands on
the spacer`, `the keyboard can be put away from the screen it covers`, `putting
the keyboard away does not end the meeting`, and `it draws nothing on the
meeting it would take you to`.

**What no test here can hold, said rather than implied.** Jest resolves
`keyboardSticky.web.tsx`, so `KeyboardStickyView` and `KeyboardController` are
executed by nothing in the suite, and jsdom hit-tests nothing — so whether the
caret actually clears the lifted transport in pixels is a device measurement.
The native half is pinned by reading its source (`the native half is the one
that translates, and this suite does not run it`), which is the honest half of
the claim; the arithmetic needs a phone.

### A meeting with no readable date is shown without one, not dropped

`groupMeetings` filed meetings by local calendar day and skipped any whose
`startedAt` would not parse. The reason given was right and the action was not:
such a meeting has no honest day to go under — today is the tempting invention
and the worst one — but *dropping* it is the unreachable-route defect one layer
down. `isSession` asks `startedAt` for a string rather than a date, so the record
loads, is **not** counted among the `unreadable`, and opens perfectly at
`/meetings/:id`, while the only list that could lead somebody to it drew
"Nothing recorded on this device yet" over it.

It gets a section of its own, headed with what is true of it, last, after every
real day so it never displaces somebody's actual week. Nothing this app writes
can produce such a record; a hand-edited one or one from another build can, which
is why the screen's test seeds it through the store rather than the controller.

The checks are `a meeting whose timestamp will not parse is shown without a day,
not dropped`, `and it goes last, so it never displaces a day that is real`, and
`a meeting with no readable date is on the list, not silently missing`.

### A meeting nobody addressed goes to the recorder's own workspace

The one-tap Record on `/meetings` asks nobody anything, so the meeting it starts
carries no destination — and something has to answer *where does this go?* The
first answer shipped was `defaultContext`, which is `role === "owner"` and
nothing else, over a list sorted oldest-first.

That is the failure this feature's own destination module exists to prevent,
arriving through the one path that never opens the sheet. Somebody who owns a
shared workspace older than their own had a transcript written into a bucket
their colleagues watch, at whatever visibility that folder carries, with nothing
on screen having named the audience. Somebody who owns no context at all but is
an `editor` somewhere fell through to `contexts[0]` — another person's context.

**The rule is `ownPersonalContext`: `kind === "personal"` and `role === "owner"`,
which is the rule the sheet's first offer already uses**, because it is the same
question. *The default is the person's own workspace, whatever context they are in*
is a privacy rule rather than a convenience, and a capture nobody filed is
exactly what it is about. `defaultContext` decides which screen somebody lands
on and nothing about a bucket.

The alternative considered was to refuse a destination-less meeting and make
one-tap Record raise the sheet. It was rejected: it reverses a stated decision
with its own argument — *"you open the app and hit record"*, no dialog between
somebody and a meeting that has already started — and it buys nothing this does
not. The sheet exists to let somebody choose *away* from their own workspace and to
put the audience in front of them when they do; a meeting that lands in their
own inbox needs neither.

Owning no workspace answers `null` and the meeting stays on the device, retried
rather than parked, so claiming an @name lands it on the next drain. Every other
fallback available at that point is somebody else's bucket.

It lives in `destination.ts` beside every other rule about where a meeting
lands, pure and reachable without a renderer — `console/capabilities.ts`'s
measured rule, and the reason this was wrong for as long as it was: the version
expressed inside the hook could not be reached by a test at all, and the file's
own header argued against the line eighty lines below it.

`gateway.ts` documented `null` as "the connection's own default context", which
is true on the HTTP path — the grant names one context, so the connection's
default and the person's workspace are the same bucket — and was silently redefined
by the Convex path, whose control-plane session reaches every context the person
is a member of. Both now say what each does.

The checks are `a meeting nobody addressed goes to the recorder's own workspace`,
`and never to a shared workspace, however old it is`, `somebody who owns no
workspace has nowhere for it to go, and is told so`, and `a context this account
cannot reach is null, not a fallback`.

### A refusal is a sentence this app wrote, and it maps the codes the server sends

Two defects with one cause: the writer read the wrong thing off the failure.

**It forwarded `error.message`.** On the wire Convex builds that as
``[CONVEX A(functions/files:writeNote)] <message>\n  Called by client``, and the
vetted `{code, message}` is on `.data`, which the code read for the code and
ignored for the message. So a stack-trace-shaped string landed in
`record.rejection.message` and was drawn on a meeting card. The far side of this
write is a customer-configured storage endpoint reached with a decrypted
credential, and what rides out of it can be a bucket name, a host, a signed URL
or a provider's raw XML — which is the argument `browser.ts`'s `toFileError`
already makes, at length, for the console: *never a raw runtime string as the
headline, that is how a stack trace ends up in a screenshot.* The meetings
writer uses that funnel now rather than a second one, which also brings the
`instanceof ConvexError` guard it was missing — `.data` was read off any object
that had one.

Every sentence a refused meeting can show is one this module owns, and the suite
asserts the set is closed. Not even the server's vetted prose is forwarded: it
is written for a file editor, and `canSee` refusing a write answers *"That file
does not exist."*, which on a meeting card is a lie.

**And it branched on codes `files.writeNote` does not send.** It handled
`FORBIDDEN` and `NOT_FOUND`; the action sends `NOT_AUTHENTICATED`,
`WORKSPACE_NOT_FOUND`, `INSUFFICIENT_ROLE`, the `STORAGE_*` family, and
`fileOps`' own codes — of which a write reaches `FILE_NOT_FOUND` (the `canSee`
refusal), `PATH_INVALID`, `CONTENT_TOO_LARGE`, `CONFLICT` and the
`PRIVACY_MANIFEST_*` family. So the branch was dead and every real refusal fell
through to `invalid`, which parks the meeting permanently. An `editor` in a
context whose meetings folder defaults to `private` got a meeting parked for
ever; so did anyone whose token happened to be refreshing.

The split is transient versus parked, because **a parked meeting waits for a
person to press retry**. Transient stays an allowlist for `classifySyncFailure`'s
reason. `FILE_NOT_FOUND`, `INSUFFICIENT_ROLE` and `WORKSPACE_NOT_FOUND` park as
`forbidden` rather than `invalid` — both park, and the difference is that these
three are the ones somebody can act on.

**A meeting whose `startedAt` will not parse is refused with a sentence too.**
`meetingNotePath` validates it before it looks at the folder, so the fallback
built for a refused *folder* re-throws; composed outside the `try`, that
`TypeError` escaped `finalize`, was classified `UNKNOWN`, parked the meeting,
and *"session.startedAt is not an ISO 8601 timestamp"* became the person's
explanation — on the same branch that added a list section for exactly that
record. The list could show it and the writer could not file it.

The checks are `` `NOT_AUTHENTICATED` is classified meeting_unavailable ``
(and its nine siblings), `a signed-out moment is retried, not a meeting parked
forever`, `a private meetings folder is refused with a sentence about the
folder`, `the wire's own stack-trace message never reaches the record`, `and
neither does the server's own prose, vetted or not`, `a code is read off a
ConvexError and off nothing else`, and `is refused with a sentence, not a
TypeError`.

### The note says the meeting is over, and Copy is the file in the bucket

`renderMeetingNote` writes `status: <session.state>`, and `pendingSteps`
guarantees the state at a finalize is `finalizing` — so this path handed it the
record's own session and **every meeting note in the customer's bucket said
`status: finalizing`, permanently**, over a meeting that was finished.

The MCP gateway does not, and says why: *"marked complete before it is rendered,
so the note's own frontmatter says what the meeting is rather than what it was
in the middle of."* The same fold now happens here, over the path the write is
about to claim.

That was also why **Copy note was not the file in the bucket.** The screen
renders from the record, which the `written` fold leaves `complete`, so the two
answers to "what is a meeting note" disagreed on the one line that says whether
the meeting is over — under a comment claiming they were the same note. They are
byte-identical now, with one stated exception: `updated` is stamped when the
text is produced, and Copy runs after the write by definition. It is left that
way rather than pinned to the write's time, because a copy claiming a timestamp
it does not have is the invented-fact defect this repository has shipped twice.

`conflictSafe` on a finalize ack was `true` and is `false`. The reasoning behind
the `true` was about `writeFile` in general; it is not true of *this* write.
`writeFile` computes `conditional = capabilities?.conditionalWrite === true &&
existing !== null`, and a create has no `existing` — that is what makes it a
create — so every meeting write this app makes is a `read-compare`, on every
backend, including the ones that honour `If-Match`. The field exists so a client
can tell a guarantee it bought from one it did not, and `localAck` answers
`false` for exactly that reason. The write is still safe against clobbering;
that is a different property, bought a different way, and is stated where it is
bought instead of borrowed as this flag.

The checks are `the note says the meeting is complete, not that it is
mid-finalize`, `are the same note, once the meeting is one the bucket holds`,
`except for \`updated\`, which is a render stamp and cannot be the same twice`,
and `an ack never claims a conditional write, because a create is not one`.

### A day's meetings are in order even when an undated one is on the list

`groupMeetings` sorted the whole list with
`Date.parse(b.startedAt) - Date.parse(a.startedAt)`. One unparseable `startedAt`
makes that return `NaN` for every pair it appears in, and `sort` only promises a
meaningful order for a *consistent* comparator — so what came out depended on
where the engine put its pivot, and the **dated** meetings came out shuffled.
Measured over 2,000 randomised orderings of three dated meetings plus one
undated: 1,346 wrong.

The section each meeting lands in was never affected, because that is keyed off
`dayKey`. What was affected is the order within a day, which is the order
somebody reads their own afternoon in — and it arrived in the same change that
stopped dropping undated meetings, so the fix for one defect introduced the
other. Partitioned before sorting: the undated ones come out before anything is
compared, and the comparator only ever sees dates.

The check is `and the dated ones stay in order with it in the list`, asserted at
every position the undated meeting can occupy in the input, seeded rather than
randomised — a test that is flaky in the direction of passing is the failure
mode this document is about.

### Android is prepared, not shipped

Owner's call (Seyi, 2026-09-07): "I'm not supporting Android just yet, but we
should prepare for it." Read literally rather than softened into either
extreme — this is not "ship it" and it is not "leave it for later" either.
**No keystore, no build, no store submission** happen as part of preparing;
what does happen is that the codebase stops being the reason a future decision
to go would take more than dispatching one workflow.

**What "prepared" turned out to mean was smaller than expected, because the
work had already been done — by a dependency, not by this repo.** The plan
going in assumed a custom Expo config plugin under `apps/mobile/plugins/`
would be needed to declare `<service android:foregroundServiceType="microphone">`
and a notification channel, because recording in the background on Android
14+ needs a foreground service actually started, with a visible notification —
the platform being right about consent, the same principle *consent is the
customer's* argues from the other direction. Reading `expo-audio`'s installed
Android module (`android/src/main/java/expo/modules/audio/service/AudioRecordingService.kt`,
`android/src/main/AndroidManifest.xml`) found that service already declared,
already starting itself with the `microphone` foreground-service type,
already creating its own notification channel the first time a recording
starts. The plugin was never needed; the only two of the four Android 14+
permissions this app has to declare itself are `FOREGROUND_SERVICE_MICROPHONE`
and `POST_NOTIFICATIONS` (see `apps/mobile/app.config.js`'s `android.permissions`
comment for exactly which of the four permissions come from where, and why all
four are listed there rather than split across two sources).

**The audio-focus worry resolved the same way, for the same reason: read the
dependency's source instead of assuming a gap.** `MEETING_AUDIO_MODE`'s
`interruptionMode: "mixWithOthers"` is what keeps a Zoom call's microphone on
iOS — *the audio session*, above — and the question was whether Android needed
a second, platform-specific answer to the same problem. It does not:
`expo-audio`'s Android `AudioModule.kt` reads the same field to decide whether
to request Android's own audio focus at all, and `mixWithOthers` is the one
value that skips the request entirely. So `audioRecorder("android")` now
answers a real `expoAudioRecorder`, the same function iOS uses, with exactly
one field threaded in that iOS's session never sees:
`allowsBackgroundRecording: true`, which is what tells that native module to
start its bundled foreground service. `expo-audio`'s own type declares that
field `@platform ios` and `@platform android` both — on iOS it gates something
this app has never touched, whether a recorder pauses on backgrounding, which
is why it is not merged into the object iOS reads: doing so would be a
behaviour change nobody asked for, smuggled in under an Android decision.

**What is genuinely still open, said plainly rather than glossed:** the
foreground notification's words. `AudioRecordingService.kt` posts "Recording
audio" / "Tap to return to app", hard-coded in Kotlin, and the installed
version of `expo-audio` exposes no option to override it. The product's own
copy for that moment — "Recording a meeting" — cannot be wired up from this
repository without either a newer `expo-audio` release that adds the option,
or a native patch of the library, and neither belongs in a "prepared, not
shipped" change. The first Android build ships the library's own words on
that notification until one of those two things happens; this is written down
rather than worked around because the alternative was to quietly ship
different copy than the rest of the feature uses, or to claim a fix that was
not made.

**What the first real Android build needs, beyond merging this:**

1. **EAS-managed keystore approval.** Nothing has ever built this app for
   Android, so no signing keystore exists yet. `eas build --platform android`
   in `--non-interactive` mode (`deploy-mobile-native.yml`) will generate one
   silently the first time it runs unattended, and a signing identity for an
   app's Play Store listing is not something a workflow should decide on
   nobody's behalf. The owner runs `eas credentials --platform android` once,
   interactively, from a machine logged into the EAS account, either
   approving an EAS-managed keystore or uploading one that already exists.
2. **A Google Play service-account key.** `eas submit --platform android`
   needs Play Console API access to upload a build; that key does not exist
   yet either, and creating one is a Play Console action only the account
   holder can take. Once it exists it becomes the `GOOGLE_SERVICE_ACCOUNT_KEY`
   secret (`scripts/secrets-allowlist.json`), and `apps/mobile/eas.json` gets
   a `submit.production.android` block naming it — `eas.json`'s own docs
   (<https://docs.expo.dev/submit/android/>) say the exact shape.

Until both are done, `deploy-mobile-native.yml`'s preflight refuses a
`platform: android` or `platform: both` dispatch outright — build, not only
submit — with those same two steps printed rather than an `eas` stack trace
partway through a run somebody else has to interpret. `apps/mobile/eas.json`
carries a `build.production.android` block (AAB, `"buildType": "app-bundle"`)
so that the day both steps are done, turning Android on is deleting that one
preflight check, not authoring a project. No `submit.production.android`
block exists yet, on purpose — JSON has no comment syntax to disable a block
in place, so leaving it out and failing loudly at the workflow level is the
next best thing to a commented-out line.

**What an OTA update can never do, restated for Android because
`runtimeVersion`'s own comment only ever had to say it about iOS before now.**
`runtimeVersion: "1.0.0"` is pinned for the life of the app, deliberately
decoupled from the marketing `version`, so one OTA channel reaches every
install ever shipped — see `app.config.js`'s own comment on the field. The
first Android binary, whenever it ships, becomes the Android floor the exact
way `UIBackgroundModes: ["audio"]` and `#161` were the iOS one: every native
capability Android needs — the permissions, the foreground service, anything
`expo-audio`'s Android module reads off the manifest — has to be in *that*
binary, because no OTA update can add a native module, a permission, or a
manifest entry to a binary already installed on somebody's phone. This PR
changes JS behaviour only (`audioRecorder("android")`, `app.config.js`'s
Android manifest additions) and ships over the air the moment it merges — that
is safe today because zero Android installs exist to receive it, not because
the OTA/native boundary has moved. The day a real Android binary exists, the
same discipline `native-deps.json`'s `core`/`gated` split already holds iOS to
applies to it without exception.

The checks are in `apps/mobile/__tests__/appConfig.test.js` (the Android
permissions are additive and iOS's rendered config is unaffected) and
`apps/mobile/__tests__/meetingsCapture.test.ts`'s `describe("android", ...)`
(real capability, the one field that differs from iOS's session, the same
`interruptionMode` mixing on both platforms, the same rotation and offset
arithmetic run under the Android platform argument).

### A `finalizing` session has a deadline, because the gateway does not need one

`finalizing -> complete` is usually one request. `MEETING_TRANSITIONS` puts no
bound on how long a session may sit in `finalizing` because most of the time it
does not need one — but "most of the time" is exactly the assumption a crash
between queuing `session` and queuing `finalize`, a lost response nobody ever
retried, or a deterministic refusal nobody looked at breaks. The owner found
this on their own machine: a meeting reading "Finalizing" for over two hours,
with a badge that carried no information about which of those had happened,
because `finalizing` meant the same word whether the gateway was a second from
answering or had not heard from this device since the crash.

The rule is `checkFinalizeTimeout` in `packages/meetings/src/recovery.js`, and
it is three things rather than one: **retry once, then fail, and never fail on
the first sighting.** A session past the bound the *first* time a client asks
is told to retry — the segments and notes are already on whichever record holds
them, so a retry costs one request, not the meeting. A session still
`finalizing` a full bound-window *after* that retry was attempted is told to
fail, which a client folds as an ordinary `fail` event — already legal from
`finalizing` and already a client-sendable event, so no new wire shape was
needed, only a client that had a reason to send it. The badge changes from an
unqualified "Finalizing" to "Failed — `<reason>`" with a Retry a person
presses, which `MEETING_TRANSITIONS.failed` already allows: `failed ->
finalizing` lets a later retry — the person's own, or a queued finalize a
client's recovery left in place — still finish the meeting normally if the
underlying problem was transient.

**Ten minutes, chosen directly rather than inherited.** Nothing in this
codebase already states a "how long may a whole meeting take to finalize"
budget — `SEGMENT_MS` bounds one rotation (twenty seconds) and the cloud
transcription rate limit bounds one minute's requests, and neither answers this
question. Ten minutes is comfortably longer than an enhancement pass over even
a long transcript, and short enough that "stuck for two hours" is caught on the
first check after the meeting actually finished rather than the fortieth.

**The rule is pure, and every surface that can get stuck calls the same
function rather than restating the arithmetic.** The gateway needs none of
this — a client-sent `fail` on a `finalizing` session was already legal before
this decision, and the gateway's own idempotency means a retried finalize
after a recovered outage lands on the one note it already claimed. What needed
building was a client that actually *asks* the question:

- **The desktop app** (`apps/desktop/src/core/sync/outbox.ts`,
  `recoverStaleFinalize`) asks it of every `finalize` entry in its outbox,
  called from `drainOnce` before anything is sent — covering both "runs
  periodically" (every drain tick) and "on app launch" (the outbox read back
  from disk on `main/index.ts` startup is checked the moment it is read,
  before the first periodic tick would otherwise get to it). A `fail` is
  queued as a `session`-kind write, which drains ahead of the stale `finalize`
  in `KIND_ORDER` — the gateway learns the session failed before anything else
  about it is attempted — and the stale entry is then dropped, so a client
  that has already said `fail` is not asked to say it again on every later
  tick forever.
- **The mobile app** (`apps/mobile/features/meetings/controller.ts`,
  `recoverStaleFinalizes`) asks it of every record in `finalizing`, called from
  `configure()` — the phone's nearest thing to a launch, reading the records
  `loadMeetings` just restored from disk — and from the top of `sync()`, so a
  session that goes stale while the app stays open is not left until somebody
  happens to relaunch it.

Both callers hold their own `retriedAt` bookkeeping (`OutboxEntry.retriedAt` on
the desktop, `MeetingRecord.retriedAt` on the phone) rather than the pure
function holding any state itself — it is a fact about a *previous call* to
this function, not about the meeting, and a gateway record has no room for it:
`endedAt` alone is enough for every caller to agree on how long a session has
been finalizing.

The checks are `checkFinalizeTimeout` in
`packages/meetings/test/recovery.test.mjs` (below the bound is left alone; at
the bound, exactly once, it is `retry`; a full window past that retry it is
`fail`; it never asks to retry a second time), `recoverStaleFinalize` in
`apps/desktop/test/outbox.test.mjs` (retried once, then a `fail` is queued
ahead of the stale entry and the entry itself is dropped, addressed to the
same context the finalize was, and a session already failed is not asked to
fail again on a later pass), and `recoverStaleFinalizes` in
`apps/mobile/__tests__/meetingsController.test.ts` (the same progression
through `sync()` and through `configure()`, the human's typed words surviving
the whole thing unchanged). **The test that fails if this is reversed:** delete
the `retry` branch from either glue function and a session's first stale
sighting is answered as already failed — a meeting whose gateway was one slow
request from `complete` is told it failed for no reason at all.

**Amended in review, before it merged: a failure nobody can undo is worse
than a session that is still trying.** The paragraph above says the badge
"changes to `Failed — <reason>` with a Retry a person presses", and the state
table has allowed `failed -> finalizing` since a partial recording had to be
writable out — but nothing in either client ever made that move.
`pendingSteps` offers a `finalize` step only for a session in `finalizing`, and
the desktop's recovery drops the stale entry outright, so the first version of
this decision turned "stuck, and still trying every drain" into "failed, and
never sent again": a phone with no signal for twenty minutes after a meeting
kept the words somebody typed on the device permanently, behind a badge that
named a failure and no control that did anything about it. That is a worse
outcome than the bug being fixed, and it is why the retry is now code rather
than a sentence: `MeetingsController.retryFinalize` folds the same `end` the
contract already had (clearing `failureReason`, restamping `endedAt`, clearing
`retriedAt` so a person's retry gets its own full window, and clearing
`acked.finalized` — without which the button does nothing in the case it exists
for, because a gateway that *accepted* a finalize and never came back with a
path is the shape the owner actually reported, and that acknowledgement is what
stops `pendingSteps` offering the step again), and
`MeetingNoteScreen`'s `Landing` gains the `failed` branch that offers it —
which also stops that screen telling a failed meeting it will be "sent as soon
as your context answers", the same false promise the `empty` branch below
exists to avoid. The checks are `nothing sends a failed meeting on its own,
which is why the person's Retry has to exist`, `Retry takes it back to
finalizing and the meeting lands in the bucket`, and `a meeting recovery gave
up on says it was not filed, and offers Retry`.

**And a client giving up races the gateway, which now ships a client that gives
up on a schedule.** A queued `fail` is an ordinary `session` write, so it can
land in the one window where the finalize has claimed a path and the note is
not yet written. The note reaches the customer's bucket a moment later and the
receipt's conditional write loses; folding `written` onto the `failed` record
that replaced it is a move the table refuses, which used to answer 400 — a
refusal the desktop outbox parks — and leave a real note in the bucket with
nothing pointing at it. The rule is that **the bucket wins**: `reopenFailed` in
`apps/mcp/src/meetings/ingest.js` takes the record back to `finalizing` through
the same `end` the claim folds, puts the meeting's own `endedAt` back, and the
receipt says `complete`. The check is `a client that gave up mid-finalize does
not leave the note it raced orphaned`, and its two neighbours pin the note and
the end time.

### Silence is not a transcript, and the engine's own evidence is what says so

Measured on the owner's Mac, on the signed build, with the console's own
counter reading it out: a recording was started, **nobody spoke**, the room was
quiet. Nothing at ten seconds, nothing at twenty, then 62 words at thirty, 87 at
fifty, 147 at seventy, **166 at ninety**. It filed as a meeting note in the
customer's bucket. The same evening a real six-minute meeting carried seven
consecutive `Thank you.` lines. And parked batches recorded from a *synthesised
counting script* carried sentences that appear nowhere in it —
`"I'm going to put it in another room."`, `"I'm sorry."`

So three facts, in the order they matter:

1. **A transcription engine handed silence answers with sentences.**
2. **It also invents them over real audio**, in the middle of real speech.
3. **The invented text is, as text, indistinguishable from the real thing.**
   There is no filter over a transcript that tells `"Thank you."` from
   `"Thank you."`, and there never will be.

The third is why nothing downstream can clean this up, and the second is why no
guard anywhere can promise to have removed all of it.

**The blast radius is the whole promise.** The bucket is meant to hold what
happened. A note full of plausible sentences nobody said is worse than a missing
note, because a missing note is visibly missing. Meeting detection being off by
default limits how often it fires today — turning it on is what would widen it —
but every Record pressed by mistake, every meeting nobody spoke in, and every
detector that fires on something that was not a meeting writes invented speech
into storage the customer owns, with nothing marking it as invented.

#### The guard that was already there, and the assumption under it

`hasNothingCaptured` (`A session that captured nothing is not filed`, above)
requires **no transcript and no typed notes**. It is correct, and it was
**unreachable for any session that opened a microphone**: the transcript half is
never empty while an engine is answering, so a mic-open session could not reach
`empty` however quiet the room was. The implementation was right and the
assumption under it was false, which is why the fix is upstream of it rather
than beside it. Nothing about `hasNothingCaptured` changed. What changed is that
a quiet chunk now really does produce no words, so the existing rule reaches the
existing state on its own. The check is `A SESSION THAT CAPTURED ONLY SILENCE
REACHES empty` in `apps/mcp/test/meetings.test.mjs`: three chunks forwarded, no
words back, `empty`, nothing in the bucket — and letting one invented segment
through turns it red.

#### What the transcription response actually carries

This was the first thing to establish and it decided everything after it.

`infra/transcribe-worker` calls Workers AI and reads **three** fields off the
answer: `text`, `segments` (`start`, `end`, `text`) and `words`. On the
`segments` it also reads a literal `confidence`, in range, or writes `null` —
and it refuses to derive one from `avg_logprob`, which is a binding decision
(`A CONFIDENCE IS NEVER INVENTED`, in that file) and is right: `exp(avg_logprob)`
is a number that looks like a confidence and means something else.

**Whisper does not emit a field called `confidence`.** Its per-segment fields are
`avg_logprob`, `no_speech_prob`, `compression_ratio` and `temperature`. So the
key is present on every segment in the customer's bucket — `intoSegments` in the
gateway writes it unconditionally — and its **value is `null` in every case**.
A field that exists is not a field that discriminates, and this one is the
former. A low-confidence filter therefore had nothing to filter on, and the
option named as "cheap if the response carries a confidence" is not cheap: it
requires first manufacturing the number this repository decided not to
manufacture.

What *was* being thrown away is the evidence that answers the actual question.
`no_speech_prob` is not a confidence — it is the decoder's own probability that
a segment contains no speech, which is precisely what is being asked — and it
arrived on every segment and was dropped on the floor. So did
`transcription_info.duration_after_vad`, the engine's own account of how much
audio survived its voice-activity front end.

#### The decision: the transcriber refuses, on the engine's own evidence

The refusal lives in `infra/transcribe-worker/src/transcribe.ts`, which is the
**one place every recorder's audio passes through** — the desktop through the
gateway, the phone and the browser through the control plane. Two rules, in
order of how much they assume:

1. **`duration_after_vad` at zero, on a chunk the engine said had a duration.**
   The engine's own VAD saying it kept no audio. No threshold of ours appears
   in that sentence, which is why it is first. Absent — the fallback model
   reports nothing of the kind — it has no opinion, and a *positive* value is
   not read as proof of speech either: VAD keeping audio is not VAD hearing a
   voice in it.

   It is a **conjunction** because this rule's two errors are not symmetric. A
   missed refusal costs one chunk, and rule 2 still applies to it. A *false*
   one — an engine build reporting `duration_after_vad: 0` over audio it never
   ran VAD on — would empty every chunk of every meeting on the deployment,
   with a 200, a bound binding and a green `/health`, which is the shape
   `isReadableAnswer` exists to stop. So it fires only when the engine reported
   a chunk of real audio **and** said its VAD kept none of it; anything short
   of that is an answer the Worker has no reading of, and it says so by not
   firing. What survives is loud rather than silent: a deployment where this
   did misfire would tell every recorder, every twenty seconds, that no speech
   was heard.
2. **`no_speech_prob > 0.6` AND `avg_logprob < -1.0`.** Whisper's own reference
   defaults, cited rather than chosen. **The conjunction is the whole of its
   safety**: a confidently decoded segment survives however unsure the silence
   detector was, so the cost of a wrong `no_speech_prob` is bounded to segments
   the decoder was *also* unsure of. Quiet speech that decodes cleanly is kept.

**Absence is never a refusal.** An engine reporting neither field — the fallback
model, a future on-device one — has said nothing about whether anybody spoke,
and *"it did not say"* must not become *"nobody spoke"*. Written the other way
round, one model change silently transcribes nothing while every health check
stays green, which is the exact failure shape `isReadableAnswer` was added for.
Six checks stand on that line, which is more than stand on the refusal itself.

#### The rule was armed, and could not fire, because nobody had asked the engine to run its VAD

Reported by the owner after all of the above shipped: *"when things are silent
it transcribes a bunch of random things."* Still. The refusal was in place, the
thresholds were the engine authors' own, and quiet chunks were still coming back
with sentences in them.

The section below had already written down why, without drawing the conclusion:
***`vad_filter` defaults to `false` on that model***, and with VAD off
`faster-whisper` sets `duration_after_vad = duration`. So rule 1 read a positive
number on every chunk, had no opinion on every chunk, and was — exactly as
documented — *"armed for a deployment that turns VAD on"*. Nobody turned it on.
That left rule 2 alone, and rule 2 is the one this file says is *"either
redundant or the whole fix, depending on a serving detail nobody outside
Cloudflare can read"*. It was redundant.

**So the Worker asks for it: `env.AI.run(TURBO_MODEL, { audio, vad_filter: true })`.**
This is not a new policy and no threshold of ours appears in it. It turns on the
engine's own front end so that the engine's own evidence exists, which is the
deployment rule 1 was written for. Two things follow and both are wanted: a
chunk that is entirely non-speech comes back with `duration_after_vad: 0` and
rule 1 fires; and a chunk that is *mostly* quiet has its silence cut **before
decoding**, which is where the hallucinations come from in the first place. The
second half needs no rule at all — it is the engine not being handed the
silence.

**Only the turbo model is asked.** `@cf/openai/whisper` declares `audio` and
nothing else, reports no `duration_after_vad` to arm anything with, and is the
only path an account without the turbo model has. An undeclared key there would
risk turning that path into a 502 to arm a rule the model cannot feed.

**What it costs, stated.** Silero VAD decides what speech is, and speech it
drops is speech nobody transcribes — the same trade rule 2 already takes, moved
one step earlier and taken by the engine's own front end rather than by a number
in this repository. It is visible rather than silent: a wholly refused chunk
puts one sentence on the recorder's screen while the meeting runs. **How a wrong
call here would show up** is that sentence appearing during a meeting people are
talking in, or a transcript with holes where a quiet speaker was — the first
thing to look at if anybody reports a short transcript.

**What this does not touch** is the half of the defect that happens at full
volume. The counting-script inventions were confidently decoded segments over
real audio; VAD keeps that audio, correctly, and `TRANSCRIPT_CAVEAT` is still
the only honest answer to it.

**And an audio gate is still not shipped.** The owner asked for "some basic
noise gate" in the same message, and the measurement below still says a loudness
threshold cannot separate this room's silence from this room's speech — the
medians are identical and the silent room's peak is louder than speech's 90th
percentile. The one measurement that would reopen it is named there and still
does not exist. Turning the engine's VAD on is the gate, taken by the thing that
has a voice model rather than by a number over a level meter.

The checks are `asks the turbo model to run its VAD, which is what arms the
silence rule` and `does not send the older model a key it does not declare`.

#### Whether either rule can fire is a property of how the engine is run, and adversarial review checked it against the vendor's schema

The numbers above were taken from the engine authors on trust; review went and
read them, and read the deployed model's own published schema beside them. Three
findings, and the third changes what rule 1 is for.

**The two thresholds are the published defaults, twice over.** OpenAI's
`whisper/transcribe.py` ships `no_speech_threshold = 0.6` and
`logprob_threshold = -1.0`; `faster-whisper` — the implementation whose
`duration_after_vad` this reads — ships the same pair, and spells the silence
test as `no_speech_prob > no_speech_threshold and avg_logprob <
log_prob_threshold`, the strict `<` this file uses rather than the `<=` the
reference's inverted phrasing implies. A segment sitting exactly on the floor is
kept here, which is the conservative direction. **And Workers AI publishes the
same two numbers as its own request defaults** for
`@cf/openai/whisper-large-v3-turbo` — `no_speech_threshold: 0.6`,
`log_prob_threshold: -1` — so this deployment's engine is calibrated at the two
values this file names.

**`confidence` is not a field, checked at the vendor rather than in our
fixtures.** That model's published output schema is
`text`, `word_count`, `vtt`, `transcription_info.{language,
language_probability, duration, duration_after_vad}` and
`segments[].{start, end, text, temperature, avg_logprob, compression_ratio,
no_speech_prob, words[]}`. There is no `confidence` anywhere in it. So
`readConfidence` here, and the three `typeof … === "number" ? … : null` writers
downstream, are pass-throughs that will carry a number the day an engine states
one and write `null` every day until then — which is why a confidence rule, if
one ever becomes possible, drops into `isNoSpeech`'s place with no plumbing.

**`vad_filter` defaults to `false` on that model, which tells rule 1 what it is
for.** With VAD off, `faster-whisper` sets `duration_after_vad = duration`, so
rule 1 reads a positive number and has no opinion — it is armed for a deployment
that turns VAD on, not the rule that catches the 166 words. Rule 2's reach
depends on the same kind of detail: the sequential `transcribe()` path applies
this exact conjunction itself and *skips the window*, so a segment that reached
us through it cannot satisfy the rule, while the batched pipeline attaches the
same two fields to every segment and yields them **without** the skip — which is
what a run of seven identical `Thank you.` lines looks like. So rule 2 is either
redundant or the whole fix, depending on a serving detail nobody outside
Cloudflare can read, and it is written to be harmless in the first case and
decisive in the second. Reading the three fields off a parked batch is what
settles it, and it is the first thing still needing a Mac.

One line changed in review as a result. Rule 1 fires on `duration_after_vad`
being **exactly zero**, not on `<= 0`: a length of audio cannot be negative, so
a negative one is an answer with no reading — the class this rule already
declines to act on — and treating it as a refusal is the catastrophic direction
the conjunction exists to close. The check is `does not fire on a negative
duration_after_vad, which is not a length`, beside eleven rows of real speech —
quiet, distant, accented, another language, music, and each field absent — that
must all survive.

#### Why not a gate on the audio, which was the obvious answer

The desktop has run an `AnalyserNode` per channel since the level meter landed,
so a loudness floor per chunk looked free. **It is not viable, and the
measurement says so rather than an argument.** Mic levels on the same Mac,
sampled at 10 Hz through the meter's own scale:

```
silence, 30s      median -43.4 dBFS                    max -28.3 dBFS
speech, loud      median -44.2 dBFS   p90 -37.2 dBFS   max -23.7 dBFS
```

The medians are identical, and **the silent room's peak is louder than speech's
90th percentile**. There is no statistic on that data — mean, median, percentile
or peak — that refuses the silence and keeps the speech. The cause is not
arithmetic and not gain: the capture already asks for no echo cancellation, no
noise suppression and no automatic gain, and a 10 Hz instantaneous reading
spends most of its samples in the gaps between words.

Three further things were true and each would have been enough on its own:

- **Nothing keeps a per-segment aggregate today.** Every reading is computed,
  posted for the meter and discarded, so a gate would have had to add the
  measurement first — it was not the free reuse it looked like.
- **A wrong threshold drops quiet speech**, which is a worse failure than a
  hallucinated note: a person can see an invented sentence and cannot see a
  missing one.
- **It would not have caught the counting-script inventions anyway.** That audio
  was not quiet. An audio gate addresses at most the silence half of a defect
  whose other half happens at full volume.

What would reopen it is one measurement nobody has: **what real speech at a
normal distance reads on this scale.** If it clears the noise floor by a wide
margin, a peak- or percentile-based gate over a per-chunk aggregate becomes
straightforward and is worth having as a second line — it would also stop a
silent room's audio leaving the machine at all, which is a privacy win the
engine-side rule cannot give. If it lands near -40 dBFS, the question is closed
for good. **Do not ship a threshold before that measurement exists**; the
"speech" rows above were taken with the machine's output volume near-inaudible
and are unsound for anything but the room.

#### Why not the gateway, which was the third candidate

Putting the policy in `apps/mcp` would keep it in one place for the desktop and
nowhere at all for the phone, which reaches the control plane instead. And the
gateway is the one participant with **no evidence to decide on**: it holds a
base64 string it must not decode and a list of sentences no filter can tell
apart. A policy there would be a threshold over text. So it carries the decision
and does not take one — `refusedSegments` passes through untouched, and an
answer with no readable `segments` at all is still a 503, because "the room was
quiet" and "the service broke" must not collapse into each other.

#### A refusal is never silent

`refused` travels: the Worker states it, the gateway and the control plane carry
it as `refusedSegments`, and both recorders turn a **wholly empty** answer with
a non-zero count into one sentence while the meeting is still running —
`CAPTURE_NOTICES.silent` on the desktop, `NO_SPEECH` on the phone and in the
browser. Without it the honest fix would have shipped as a *second* silent
failure: an empty chunk looks exactly like a transcriber that has stopped
working, and both are a rail that never fills.

Two details are load-bearing. **Only a wholly empty chunk says anything** — a
meeting with pauses refuses the odd segment continuously, and a sentence per
pause teaches somebody to ignore the sentence that matters. And **everything
unreadable is zero, on every hop**: a gateway or control plane one deploy
behind, a proxy that rewrote the body, a string where a number should be. None
of those is evidence that a room was quiet, and reading them as such would
announce that no speech was heard during a meeting somebody is talking in.

The gateway's `empty` sentence stopped naming a fault for the same reason. *"none
of it could be transcribed"* was true while an empty transcript had one cause; it
now has two, and this gateway cannot tell them apart without a conditional write
per chunk on a customer's bucket — every twenty seconds, to improve one sentence
the recorder has already said better and earlier. So it says only what it knows:
`Audio was recorded, but no words came back from it.`

#### And what cannot be ruled out is disclosed rather than presented as certain

The counting-script inventions are the reason `TRANSCRIPT_CAVEAT` exists. They
happened over real audio, at full volume, in confidently decoded segments — no
rule above touches them, and none ever will, because a confident invention is
what a correct transcription looks like. So a machine transcript now says so, in
one line leading its own section:

> `_Transcribed automatically. Speech recognition mishears, and can produce
> sentences nobody said._`

`transcription: cloud` in the frontmatter is **not** this. That key answers
"where did my audio go"; it does not answer "can I trust this sentence", and it
is read by machines rather than by the person skimming their own note — or
quoting it back to somebody who was in the room.

It is written only where there is a machine transcript to caveat: never on a
notes-only meeting, never above the placeholder, never over a session naming no
engine or an engine nobody recognises, and never on a meeting whose only body is
the wearer's own flags. **A caveat on everything is a caveat nobody reads**, and
six checks stand on the version that writes it regardless.

#### What this costs, stated

A segment the engine is unsure of *and* marks as probably-silent is dropped, and
some small number of those will have been real quiet speech. That is the trade
taken deliberately, at the engine authors' own thresholds rather than ours, and
it is visible rather than silent: the person is told, per chunk, while the
meeting runs. **How a wrong threshold would show up** is that notice appearing
during a meeting people are talking in, or a transcript with holes where a quiet
speaker was — which is why the notice is a sentence about *what happened* rather
than a shrug, and why it is the first thing to look at if anybody reports a
short transcript.

**The test that fails if this is reversed:** record a quiet room, forward the
chunks, finalize. With the rule, the session is `empty`, the bucket gains
nothing, and the person was told why while it was running. Reversed, 166 words
nobody said land in the customer's own storage under a heading that says they
are a transcript.

### A session that captured nothing is not filed

The owner's other bug report, found on the same machine the same day: four
empty notes in the bucket, one per recording attempt where the microphone was
never granted, each "0 min, typed session" with no transcript and no typed
notes. The write path was faithfully filing nothing — `finalizing -> complete`
had no floor under it, so a session with literally no content in it produced a
note exactly the way a real one does, placeholders and all.

`hasNothingCaptured` in `packages/meetings/src/session.js` is the one rule:
`session.transcript.length === 0 && session.notes.trim() === ""`. Both halves,
because either one alone is a real meeting — a transcript with no typed notes,
or typed notes with no audio at all (`a meeting nobody recorded still
finalizes`, above), are both meetings this product exists to capture. Only the
conjunction is nothing.

**A session that qualifies moves to a new terminal state, `empty`, rather than
being refused, silently dropped, or read as `failed`.** Each of the
alternatives was wrong for a different reason: refusing the finalize forges a
retry loop against a client that did nothing wrong; dropping it silently is
the exact "appears to work and does nothing" defect this repository keeps
finding elsewhere; and `failed` already means something specific — a capture
problem a retry might fix — which a session with nothing in it is not: there
is nothing to retry, only a meeting to record again. `MEETING_TRANSITIONS`
gained `finalizing -> empty`, terminal like `complete`, and `MeetingSession`
gained `emptyReason`, on the same rule `failureReason` follows (null in every
other state, set on the way in, and never rewritten).

**The gateway decides, never the client alone, and the check is re-run rather
than trusted.** `finalize -> empty` is a `GATEWAY_EVENT_TYPES` member, beside
`written`, and for the same shape of reason: a client able to assert `empty`
unchecked could make a real transcript disappear as easily as report an
honestly empty one. Unlike `written`, though, there is no asymmetric knowledge
here — a client holds the same transcript and the same notes the gateway does
— so `applyEvent`'s `empty` case re-derives `hasNothingCaptured` from the
session it is actually folded onto and refuses the event outright if the
session has content, rather than trusting whoever sent it. That is what makes
it safe for a client to fold *and* for the gateway to fold, from the same
function, with the same guarantee either way.

**The reason is the client's to give and the gateway's to accept or replace.**
`FinalizeBody.emptyReason` is an optional hint — "microphone not granted" reads
better on a badge than a sentence the gateway would otherwise invent — capped
at `REASON_MAX` and never a trigger: a client naming a reason on a session that
turns out to have content is simply not read, because `hasNothingCaptured`
decided the outcome before the reason was ever looked at.

**Where each surface stops it, and why it is not the same layer twice.** The
gateway (`apps/mcp/src/meetings/ingest.js`, `finalizeSession`) is the one
choke point for the desktop app's HTTP path and is authoritative regardless of
what any client does or fails to do — a future client that never learns this
rule still cannot write an empty note. The phone's Convex path
(`apps/mobile/features/meetings/convexGateway.ts`) has no gateway process of
its own to be authoritative *for* — this app composes the note directly, the
way `docs/decisions/meetings.md`'s "A meeting is written the way a note is"
section already describes — so `controller.end()` (`apps/mobile/features/
meetings/controller.ts`) checks `hasNothingCaptured` locally, before `sync()`
ever runs, and `convexGateway.finalize()` checks it again as a backstop in
case that first check is ever bypassed. Neither is redundant: the controller's
check is what stops the request from ever being made, and the gateway's is
what stops the request from ever succeeding if it is.

**Nothing about `.meetings/` records changes.** `finalizeSession`'s claim step
is skipped entirely for an empty session — no path is ever reserved, so there
is nothing for `releaseClaim` to give back — and the session record itself
becomes the answer, the same way a completion receipt is for a written note.
`upsertSession`, `appendSegments` and `replaceNotes` all treat `empty` as
terminal, the same as `complete`: a stray segment or a note typed after the
fact is refused rather than silently reopening a meeting that has already been
decided to have nothing in it.

**Nothing is written, and nothing is filed — but nothing is forgotten either.**
No `0-inbox/meetings/*.md` is created. The session record persists (on the
gateway path) or lives on the device (on the Convex path) with `state: empty`
and `emptyReason` readable back, so the console shows "Nothing was captured:
`<reason>`" and offers Record again — `apps/mobile/features/meetings/
MeetingNoteScreen.tsx`'s `Landing` component, checked before the generic
`notePath === null` branch so an empty session is never told "Not in your
bucket yet, sent as soon as your context answers", which would be a promise
this session can never keep.

**Nothing is deleted, because there is nothing of a recording left to delete.**
The question a review has to ask of a rule that files no note is whether it
throws away a recording, and the answer is a property of the product rather
than of this code: *audio is never persisted by us* — no adapter writes audio to
the bucket, a chunk kept on the phone is kept only until its words land (*Audio
nobody has transcribed yet is kept on the device*, above; a meeting with any of
it waiting is never `empty`), and `empty` writes and
deletes nothing at all: no note, no claim, and the session record itself stays
readable with its reason. So the case that looks like data loss — a meeting
whose audio was captured and whose transcription failed on every chunk, which
is a defect this repository has had — is a meeting whose audio was already gone
under every version of this rule. What `empty` costs it is the note that would
have recorded that the meeting happened at all, and what it buys is that the
person is told, in the app, instead of finding a blank file in their bucket.

The one thing that must not survive that is a wrong sentence. A device's
`emptyReason` is a guess about its own microphone, and on the path where **this
gateway took the audio** it is a guess that is wrong in the direction somebody
acts on — they go and check a permission for a recording that really happened.
`transcribedChunks` is spent before a byte is forwarded, so the gateway knows,
and its own sentence replaces the hint: `Audio was recorded, but none of it
could be transcribed.` The check is `...but it is not told the microphone was
the problem, because this gateway took the audio`.

The checks are `hasNothingCaptured` and the `empty` event's own guard in
`packages/meetings/test/session.test.mjs` (both halves required; a transcript
alone or typed notes alone are real meetings; the event is refused on a
session that captured something; the reason is capped, not rejected; replay is
idempotent), the gateway's in `apps/mcp/test/meetings.test.mjs` (no note
written, the reason round-trips through a `GET`, a re-finalize answers with
the same reason, a stray segment or note after the fact is refused, and a
client-named reason on a session that turns out to have content is not what
decides the outcome), and the phone's in
`apps/mobile/__tests__/meetingsController.test.ts` and
`__tests__/meetingsScreens.test.ts` (the gateway is never asked at all, the
device's own capture reason is used when there is one and a generic sentence
when there is not, and the screen never claims "not saved yet" about a session
that will never be saved). **The test that fails if this is reversed:** record
a session with no transcript and no typed notes and finalize it — with the
rule, `state` is `empty` and the bucket gains nothing; reversed, a fourth empty
note lands beside the three the owner already found.

### A recording that has outlived its own capture is failed, not counted

Found the same way the two decisions above were: on the owner's own Mac, after
a reinstall and a relaunch. The app came back showing a live recording bar
counting **2 hours 41 minutes**, no capture window behind it anywhere, and the
meeting row itself sitting as a Draft. Two defects, the same shape as the level
meter that always read zero and the failure label that always blamed the
microphone: an indicator that says the same thing whether or not the thing it
describes is happening.

**The first was in the console's own boot path, and it is the more serious of
the two.** `MeetingsController.configure()` — "the phone's nearest thing to a
launch," in the same sense `recoverStaleFinalizes` already reads that sentence
— restores whatever `loadMeetings` finds on disk and, until this fix, believed
a record that read `recording` or `paused`. `elapsedMs` in `session.js` is
`recordedMs` plus `now - runningSince`: honest while a real recorder is
feeding it, and simply wrong once the process that opened that recorder is
gone, because nothing ever told the restored session so. A relaunch is
therefore not merely *a* moment this can happen, it is **the only** moment it
can: every `MeetingRecorder` this app can hand `configure()` —
`capture/audio.ts`, `capture/audio.web.ts`, `capture/desktop.ts`,
`capture/notesOnly.ts` — is a fresh object that starts at `"idle"`, and none of
them has an OS API to ask "is something already recording session X". So a
`live` record surviving into a fresh `configure()` is proof, not suspicion,
that whatever process was capturing it is gone.

**The second was in the desktop shell's own tray-path recorder, and it is the
subtler one: `MeetingController.elapsedMs()` in `apps/desktop/src/core/
recording/controller.ts` was `now - startedAtMs`, unconditionally — the exact
sentence `core/tray/presentation.ts`'s own `TrayInput.elapsedMs` docblock used
to carry, word for word: "wall clock since the recording started."** That is
correct only as long as nothing can stop capturing without saying so, and
something could: `main/capture.ts`'s hidden capture window can crash
(`render-process-gone`) or be torn down by anything other than this class's
own `stop()`, and until this fix nothing told the controller when it did.
`MeetingController.fail()` already existed — `MEETING_TRANSITIONS.failed` has
allowed `recording -> failed` and `paused -> failed` since the finalize-
deadline work above needed them — but **nothing in the whole app ever called
it**. A capture that died mid-meeting left `#capturing` on the recorder
answering `false` (honest) beside an elapsed clock climbing from a timestamp
regardless (not), which is a machine that already knew the truth and an
interface that declined to ask it.

**The choice, for both: `fail`, never a silent reset and never an automatic
finalize.** Three options were on the table and two of them cost something
specific.

- **Silently resetting to `idle`** erases the transcript and the notes already
  captured — the same loss `hasNothingCaptured` already refuses to manufacture
  by writing a blank note, arriving one state earlier and by omission instead
  of by commission. A person who typed for ten minutes before a restart would
  find nothing anywhere.
- **Finalizing it automatically, unasked,** writes a note under a title and to
  a destination the person never confirmed as final while the meeting might
  merely have been *interrupted* by the restart rather than *over*. This
  product's whole complaint about a meetings feature that decides things on
  its own is `docs/decisions/meetings.md`'s own "the human's words are never
  rewritten" — deciding a meeting is finished is a bigger claim than that.
- **`fail`**, which is what shipped, does neither. It closes the open interval
  at the moment of discovery — `session.js`'s `fail` case already does this
  exactly right, via `closed()`, and the desktop controller's `fail()` now
  matches it by stopping the recorder for an authoritative count rather than
  trusting its own bookkeeping — so `elapsedMs`/`recordedMs` read precisely
  what was captured and no more. It keeps the transcript and the notes
  untouched. It is visible: `meetingBadge` in `apps/mobile/features/meetings/
  format.ts` already renders `failed` as "Failed — `<reason>`" rather than
  "Draft", which is the fix a reader sees without reading a line of this file.
  And `failed -> finalizing` already existed for the stuck-finalize case above,
  so **a recovered session reaches finalize through the same door a stuck one
  does** — `retryFinalize` on the phone, and pressing End again in the
  desktop's own notepad (`end()`'s `this.#moveTo("finalizing")` accepts
  `failed` the same as `recording`) — composing with the finalize-deadline and
  nothing-captured rules rather than a second mechanism beside them. A session
  reconciled this way with nothing in it still reaches `empty`, not a blank
  note, through the exact same `hasNothingCaptured` check every other path
  already goes through.

**The reason is the device's, not the meeting's**, the same distinction
`captureError` already draws on the phone: nothing about the conversation
failed, this app's own process ending mid-recording is what stopped capturing
it — `INTERRUPTED_RECORDING_REASON` on the phone, the recorder's own crash
message on the desktop (`"the capture window's renderer stopped (<reason>)"`
or `"...closed unexpectedly"`), never a sentence that reads as the meeting's
fault.

**Deliberately not run from `sync()`, and not on the fast-path `configure()`
that keeps a live recorder.** `MeetingsController.configure()`'s existing
same-workspace branch — the one `retainedRecorder` exists for, because a
recording has to survive a screen remounting — returns before the
reconciliation runs, on purpose: the guarantee above ("a fresh recorder is
always idle") holds only at the one moment a *fresh* recorder was actually
handed in, and running this on every remount would fail every meeting the app
is legitimately still recording the instant a screen unmounts and remounts.
`recoverInterruptedRecordings` is therefore a sibling of
`recoverStaleFinalizes` with a narrower trigger, not a periodic check: it runs
once, at the boot branch only.

**On the desktop side, the tray gained a sixth state to say this honestly.**
`core/tray/presentation.ts`'s `TrayState` gained `"failed"`, with the
indicator **off** — the one state whose whole point is that nothing is
capturing any more — rather than reusing `recording`'s presentation with a
frozen number, which would have kept claiming a microphone was open the moment
after this fix taught the controller it was not.

**What a Mac cannot confirm, stated rather than assumed.** `main/capture.ts`'s
crash listener (`render-process-gone`, and `closed` guarded against the
window's own `stop()`) is reasoned from Electron's documented events and
verified by the launch smoke test starting for real, not independently unit
tested — the same limitation this file's own header already states about
system audio and the loopback tap: driving a real `BrowserWindow` needs a real
Electron process. What *is* tested, and is the layer that actually matters —
`MeetingController` never knows or cares whether `onDied` came from a real
crash or a test's `fakeRecorder().kill()` — is the full state machine this
signal drives: `apps/desktop/test/controller.test.mjs`'s "the app cannot claim
to be recording when it is not" block. Somebody has to crash the real hidden
window on a Mac and watch the tray go to `failed` rather than freeze.

The checks are `apps/mobile/__tests__/meetingsController.test.ts`'s "the app
being killed mid-meeting" describe block (a relaunch never resumes a running
timer, closed with exactly what was captured; a paused session is reconciled
the same way; a genuinely still-finalizing session is untouched; the
same-workspace fast path never fails a meeting that really is recording; what
was captured survives and Retry reaches a finished note) and
`apps/desktop/test/controller.test.mjs`'s new block (elapsed counts only while
audio is actually captured and freezes across a pause; a typed meeting keeps
plain wall clock, having nothing to lie about; a capture that dies mid-meeting
moves to `failed` with the frame already captured kept, the clock frozen, and
the indicator honest; a death with nothing captured yet is still `failed`
rather than silently `idle`; a `fail()` arriving after the meeting is already
`complete` is ignored rather than resurrecting it) and `apps/desktop/
test/tray.test.mjs`'s indicator sweep, widened to the sixth state.
**Sabotage, measured**: removing the mobile reconciliation call from the
boot branch of `configure()` — 3; running it on the same-workspace fast path
instead of only at boot — 1; reverting the desktop controller's `elapsedMs()`
to plain wall clock — 3; leaving `onDied` unwired in `begin()` so a died
capture is never reported at all — 6; dropping `fail()`'s own transition guard
so a message arriving after `complete` resurrects the session — 1; flipping
the tray's `failed` presentation to `indicator: true` — 2.

## A segment id names its own meeting, and both sides check it

A recorder derives every segment id from the session it was minted for —
`segmentId(sessionId, index)` in the desktop transcriber, and
`chunkIdFor(`${sessionId}-${channel}`, n)` through `segmentIdFor` on the cloud
path. That was done so a re-send merges rather than doubling a transcript, and
it has a second property nobody was reading: **the id says whose words these
are, independently of the envelope carrying them.**

The evening that made that matter: `MeetingsController.listenToRecorder`
subscribed a fresh `onSegment` handler on every `start()` and discarded the
unsubscribe the recorder returned, and the recorder outlives a meeting on
purpose (`retainedRecorder`). So the handlers accumulated — one per meeting ever
started in the process, each closing over its own `meetingId` — and every
segment of the meeting being recorded now was folded into the projection of
every meeting recorded before it. Eight of the owner's meetings ended the night
with a `segments` write full of a *later* meeting's transcript, addressed
correctly, by a sync layer that had no way to know. Each was refused 400 and
parked, and the refusal said `gateway answered 400` and nothing else.

**The refusal was a coincidence, not a defence.** `appendSegments` refuses a
batch on a `complete` session because that meeting is a note now; every stale
session that night happened to be complete. A stale id pointing at a session
still *open* — two meetings close together, a finalize that had not drained
because the laptop was offline — would have been accepted, and one meeting's
words would have been rendered into another meeting's note in the customer's
bucket. Nothing downstream could have caught it: by the time a segment is a turn
under `## Transcript` there is no id left to check.

So the rule is: **a segment whose id names a meeting other than the session it
is being written to is refused, on both sides, loudly and by name.**

- `segmentSessionId` and `foreignSegmentSessions` in
  `packages/meetings/src/protocol.js` are the one implementation of "which
  meeting does this id name".
- The gateway refuses at both doors — `appendSegments` and the replay path in
  `foldLog` — with `meeting_invalid` naming the meetings involved and nothing
  of the text.
- The clients refuse before enqueueing: `queueWrite` in the desktop's outbox
  strips foreign rows (in the reducer, so no enqueue can skip it), and the
  mobile controller's `apply` drops a misaddressed event and logs the two ids.
- `applyMeetingEvent`'s `segment` and `segments` cases now consult the session
  state like their neighbours, so a `complete` projection refuses transcript
  whatever sends it — which is what stops a client queueing a write its own
  gateway will refuse.

**An id that names no meeting is accepted.** The phone's recorders key their
chunks on `String(Date.now())`, so their ids name nothing, and a client this
contract has not met is in the same position. Unaddressed is not misaddressed. A
guard on somebody's transcript may only fail in the direction of accepting what
it cannot prove wrong; the alternative is a gateway that silently stops taking
words the day a recorder changes how it mints ids.

**The whole batch is refused, not the offending rows.** `countUnusable`'s "store
forty-nine of fifty" is right for a row the merge cannot read and wrong here: a
batch with somebody else's words in it was addressed by something that does not
know whose words it is holding, and the rest of it is no more trustworthy than
the part that gave it away.

**What a "simplification" of this costs.** Dropping the check leaves the
correctness of every transcript resting on every client keeping its
subscriptions straight, forever, with the only symptom of a mistake being a
refusal about *state* — which is what sent three people down three wrong
diagnoses before anybody read a segment id. Accepting segments on a `complete`
session, which was the tempting fix while this looked like a late transcription
tail, would have turned the same defect into cross-meeting contamination in the
bucket.

**The tests that fail if it is reversed:** in
`apps/mcp/test/meetings.test.mjs`, post a batch whose ids carry another
meeting's id to an **open** session and expect 400; in
`apps/mobile/__tests__/meetingsController.test.ts`, start a meeting, end it,
start a second, emit one segment and expect the first meeting's transcript to
be empty and the recorder to hold exactly one subscriber; in
`apps/desktop/test/outbox.test.mjs`, queue a foreign batch and expect nothing
of it stored.

## The phone had one barrier where the desktop has four, and both halves are named

An adversarial review of the section above named an asymmetry the section
itself did not: contamination is *impossible* on the desktop path — the
gateway door at the bottom of it is one no client can talk past — and was
merely *prevented, and not independently guarded,* on the phone's. Two
separate reasons, and they get two separate answers.

### Reason one: a phone chunk id named no meeting, so the identity check waved it through

`capture/audio.ts` and `capture/audio.web.ts` keyed every chunk on
`sessionKey = String(Date.now())`. That id is stable across a re-send of the
same chunk — which is all `chunkIdFor`'s own idempotency test ever checked —
but it names no meeting, so `segmentSessionId` read every phone segment as
**unaddressed**, and `foreignSegmentSessions` built on it could never answer
anything but "nothing foreign here", whatever the segment actually was. That
is not a smaller guarantee than the desktop's check; it is the same check with
nothing for it to check. Three places lean on that function and all three were
therefore inert on this path, silently, for exactly the reason a wrong
envelope defeated them on the desktop: the check only catches what an id
*says*, and a phone id said nothing.

- `apps/mcp/src/meetings/state.js`'s `assertSegmentsAddressed` — the gateway
  door — never had a phone id to refuse, because this app's meetings never
  reach it at all (reason two, below).
- `apps/mobile/features/meetings/controller.ts`'s `apply` — the mobile
  controller's own mirror of the same check, added in the same change that
  fixed the desktop's leaked subscription — was live in the sense that it ran,
  and inert in the sense that a phone id could never fail it: unaddressed is
  accepted by design, and every phone id was unaddressed.
- `apps/mobile/features/meetings/convexGateway.ts`'s finalize path had no
  check at all until this change (see reason two).

**Fixed by minting the id the same deterministic way the desktop already
does.** `capture/audio.ts` and `capture/audio.web.ts` now take the meeting id
from `CaptureOptions.sessionId` — the controller's own `newMeetingId()`,
already threaded through every `recorder.start()` call — and build every
chunk id as `${meetingId}-${index}` through the same `chunkIdFor` the desktop
calls with its own session id. `segmentSessionId` now reads a phone segment's
own meeting back out of it, so `foreignSegmentSessions` is live on `apply`
exactly where it was inert, and would be live at the gateway door too on any
future path that reached it.

**A missing id is refused rather than answered with a clock reading.** Both
recorders throw before opening the microphone if `CaptureOptions.sessionId` is
absent — `desktop.ts`'s own `requireSessionId`, restated in each — because a
generated fallback here is exactly how this guard goes back to being inert,
quietly, the day some caller forgets to pass it. `controller.ts` always does;
a caller that does not has a bug, and it is loud on the first press rather
than found in the next contamination review.

**What happens to a segment already stored under a timestamp-shaped id.**
Nothing, and that is the safe answer rather than an oversight. `chunkId`
minted before this change is not rewritten by it — an id is fixed the moment a
chunk is minted, and nothing here revisits a chunk after the fact — so it
stays exactly the shape `foreignSegmentSessions` already treats as
**unaddressed, never misaddressed**: a client this contract has not met names
none either, and the two are answered identically on purpose (see the
section above). A device mid-recording when this ships keeps minting from
whatever `sessionKey` its already-running capture opened with, which does not
change until the next `start()`; the meeting after that mints addressed ids
from its first chunk. A batch mixing old-shaped and new-shaped ids for the
*same* meeting merges by id exactly as it always has and is refused by nothing
new — the guard only ever fails in the direction of accepting what it cannot
prove wrong, and an old id proves nothing wrong about itself. There is no
migration to run and nothing to backfill: the fix changes what a client mints
from here on, not what a contract remembers about a chunk already sent.

### Reason two: the phone's note write passes no gateway door at all

The desktop's fourth barrier is `apps/mcp`'s `appendSegments` and `foldLog` —
a door no client can talk past, because the gateway is the only party that can
put a note in the customer's bucket on that path. The phone has no such door.
`convexGateway.ts`'s own header already says why: this app holds a
control-plane session, not an MCP grant, so `finalize` renders the transcript
itself and writes it with `files.writeNote` — the same generic action every
note save uses, which has never heard of a meeting and could not refuse one on
its own terms if it wanted to.

**Two ways to close that, one of them a larger change than this one.**

- **Route the phone's transcript through the same door the desktop uses.**
  That means the phone acquiring an MCP grant — the OAuth client registration
  flow `packages/hook` ships and the desktop already runs — instead of, or
  alongside, its control-plane session. *The desktop is an OAuth client of the
  gateway, and it asks for the tier its meetings are filed at* (above) argues
  at length for why that credential shape is not one to hand a phone lightly:
  a control-plane session already reaches every context its owner is a member
  of, and a phone able to *also* mint a narrower, revocable grant is two
  credentials doing one job with no clean story for which one a given
  request used, which is exactly the two-credentials defect
  `docs/decisions/desktop.md` had to close for the *desktop* shell before its
  own meetings could be trusted. Building that story correctly for the phone —
  deciding whether it replaces the control-plane path, when it is minted, how
  it is revoked independently, what a phone with no grant yet does with a
  meeting it already recorded — is a real project, not a guard, and this
  document says so plainly rather than reaching for a shortcut that repeats a
  mistake this repository has already paid to fix once.
- **Add the identity check where the phone actually writes.** Chosen. It is
  not the gateway's guard — nothing stops a rebuilt client from skipping a
  function call the way nothing stops it from skipping any other client-side
  check — but it is the strongest one available without the change above, and
  it closes the gap the leaked-subscription bug actually demonstrated: a
  transcript built from foreign words by an honest client with a bug in it,
  not a hostile client rewritten to lie.

**What was built.** `convexGateway.ts`'s `finalize` now calls
`assertOwnTranscript` before it renders or writes anything:
`foreignSegmentSessions(session.id, session.transcript)`, the same function
the gateway and the controller's own `apply` already use, run once more
against the *whole* transcript at the last moment before it becomes a note.
`apply` already keeps a foreign segment out of `session.transcript` on the way
in (reason one, now live); this is what catches one that reached
`session.transcript` some other way — a record restored from disk, a future
code path that folds a segment without going through `apply`. A transcript
that fails it is refused with `meeting_invalid` and nothing is written; the
refusal names no meeting and quotes no word of the transcript, the same
restraint `assertSegmentsAddressed` and `apply` already hold to.

**Stated exactly, because a reader should not have to infer it from the
fix's shape:** contamination on the phone path is now **prevented by two
independent guards** — the identity check on the way a segment is folded in
(now live, per reason one) and the identity check on the way the transcript
is written out — where the desktop has four, one of which is a boundary no
client can cross. It is **not impossible** on the phone the way it is on the
desktop, and the difference is *who* enforces each guard. `appendSegments` on
the gateway is enforced by a party other than the client making the
request — the customer's own credential reaches a Worker this repository
operates, and no rewrite of the client's own code changes what that Worker
checks before it writes. Both of the phone's guards, `apply`'s and
`assertOwnTranscript`'s, are enforced by the same binary that is asking to be
trusted: a build of this app that dropped either call would still hold a
valid session, `files.writeNote` would still take whatever it was handed, and
nothing on the far end would know a check was ever supposed to run. That is
the honest cost of not making the larger change above, named here rather than
left for the next adversarial review to find.

**The checks are** `a chunk's id names the meeting it was recorded for, and
only that one` (`apps/mobile/__tests__/meetingsCapture.test.ts` and its
`meetingsCaptureWeb.test.ts` sibling), `a recorder given no meeting id refuses
to start, rather than inventing one` (same two files), `a transcript carrying
another meeting's words is refused, not written` and `a transcript whose ids
name no meeting at all is not contamination`
(`apps/mobile/__tests__/meetingsConvexWriter.test.ts`).

## The count is a kind, not a number, and every one of these guards reads an id

A post-merge adversarial review of the section above accepted its argument and
corrected two of its sentences. Both corrections are about the same thing:
what these guards are actually made of.

### Three client-side barriers on the phone, not two, and that is not the point

The section above counts **two** for the phone against the desktop's four. On
like-for-like terms it is three, because the desktop's four include one the
phone has had all along: `applyMeetingEvent`'s `acceptsTranscript` check, which
refuses transcript folded into a terminal session whatever sends it, is one of
the four *A segment id names its own meeting* lists, and it is in
`features/meetings/session.ts` — the phone's own reducer. So the phone has
`acceptsTranscript`, `apply`'s identity check and `assertOwnTranscript`, and
the desktop has those three plus `queueWrite`'s strip in the shell's outbox and
the gateway's `assertSegmentsAddressed`.

Counting it correctly makes the real asymmetry easier to see rather than
harder, which is why it is worth correcting: **the difference between the two
paths was never the count.** Every guard on the phone's list is enforced by the
binary asking to be trusted. Exactly one guard on the desktop's list is not.
Adding a fourth and a fifth client-side check to the phone would not move it
one step toward the desktop's position, and the section above is right that the
only thing that would is the OAuth-grant project it declines. A number invites
the reading that the gap is three guards wide; it is one *kind* wide.

### An id that says nothing is accepted at every door, the gateway's included

`segmentSessionId` answers `null` for an id whose first token is not a meeting
id, and every check built on it — `apply`, `assertOwnTranscript`,
`queueWrite`, and `assertSegmentsAddressed` at the gateway — treats `null` as
*addressed correctly*. That is deliberate and argued above. What follows from
it, and is not said above, is that **a client is not stopped by any of these
guards if it simply stops naming meetings in its ids.** It does not need to lie
about whose words it is holding; it only needs to stop saying. The desktop's
gateway door refuses the same batch a client sends with a foreign name on it,
and accepts it with no name on it.

So *"a boundary no client can talk past"* is exact about **misaddressed** words
and not about **unaddressed** ones, and "contamination is impossible on the
desktop path" should be read as: impossible for a client that names its
meetings at all. Every client in this repository does, and the guard is what
catches the bug this repository has actually had — a leaked subscription
inside an honest client, which goes on minting correct ids while routing them
to the wrong session. Against a client rewritten to lie the guard was never the
defence, and against one rewritten to say nothing it is not either.

**And the acceptance stays.** The tempting narrowing is to refuse an
unaddressed transcript once a client is known to address its ids — by the
record's own version, or by refusing a transcript that mixes addressed and
unaddressed rows. Neither is worth what it costs:

- The marker that would separate genuinely old data from a client that stopped
  addressing has to be written by the same binary whose honesty is in question.
  A build that drops `assertOwnTranscript` drops a version stamp just as
  easily, so it buys nothing at all against the case it is aimed at.
- Against the case that is *not* aimed at — an honest client whose transcriber
  stops deriving segment ids from the chunk id, which is a change somebody
  could make in `capture/transcriber.ts` without ever thinking about meetings
  — it would refuse to write real meetings that are nobody's but their own.
  That is a refusal in the one direction this contract says a guard on a
  transcript may not fail in: *refuse what is provably somebody else's, wave
  through what you cannot know*.

The narrowing that would genuinely close it is the one already named and
declined: a party other than the client deciding what a meeting's words are.
Until that exists, "prevented, not impossible" is the honest description of the
phone — and of the desktop too, one degree further out.

### One device records one meeting, said out loud

The same review found the one place the phone's new ids changed a silent
failure into a different silent failure. `MeetingsListScreen` hides its record
button while a meeting is live; the console's own Record key
(`ConsoleBottomBar`, in `app/(app)/console/_layout.tsx`) is drawn whether or
not one is, so `controller.start()` really can be called for a second meeting
while the first is still recording. Both phone recorders answered that by
returning silently — right for the *same* meeting twice, since a double press
is one start — and went on minting chunk ids for the meeting they opened with.
Before the ids named a meeting that was contamination with no name on it: the
first meeting's audio landed in the second meeting's transcript, at the first
meeting's offsets. Now that they name one, `apply` refuses every one of those
segments, correctly, and the second meeting records **nothing at all** and says
nothing about it.

So the recorder refuses instead: a `start()` for a meeting other than the one
it is recording throws `ALREADY_RECORDING`, which `controller.start` already
handles the way it handles a denied microphone — the session stays, the notepad
keeps working, and the sentence goes on the live screen. A `start()` for the
meeting already running is still one start, unchanged. The recorder is the only
place that knows both meetings' names, which is why the guard is there rather
than in the screen that drew the button; a screen that also stopped offering it
would be an improvement to the same situation and not a substitute for this.

### A refusal is a sentence somebody's log file keeps

The same review looked again at `describeEventType`, added above to stop
`foldLog` echoing an unrecognised `event.type` back unbounded. The bound was on
the length and not on the shape, and the reason the bound exists is that this
sentence is written to a customer's log by `apps/desktop` as the *tail of one
line*: `meeting_write_refused session=… kind=… status=… code=…: <sentence>`. A
newline forges a second line in that file in one character, and an escape
sequence rewrites the line already printed in four — neither of which forty
characters is any defence against.

So the shape is checked before the length: an event type in this contract is an
identifier, so one that is not is described (`non-identifier`) rather than
quoted, and one that is keeps being named and truncated as before, because
naming it is the one thing a client author can act on. This is
`assertSafeEtag`'s rule in `src/store/index.js` — a value about to be
interpolated into a line with structure gets its charset checked, not its
length — applied to the one refusal in this file that carries a client's own
text.

**The checks are** `a second meeting is refused rather than recorded under the
first one's name` and `...and starting the meeting that is already running is
still a no-op` (`apps/mobile/__tests__/meetingsCapture.test.ts` and its
`meetingsCaptureWeb.test.ts` sibling), `acceptsTranscript reads the table,
rather than agreeing with today's copy of it`
(`apps/mobile/__tests__/meetingsSession.test.ts` — the zero-failure sabotage
row above, made to fail), `the terminal states ingest.js names by hand are
exactly the table's own` and `an event type carrying a newline is described
rather than echoed into a log line` (`apps/mcp/test/meetings.test.mjs`).

## A refusal is shown with the reason the gateway gave for it

`postEntry` read a `message` field off an error body. The gateway's meeting
routes answer `{error, error_description}` and have never sent `message`, so
for the whole life of the desktop app every refusal — in the tray, in the
console, in the queue file on disk — read `gateway answered 400`. The sentence
explaining it was on the wire, parsed, and thrown away one line from where it
was needed, and eight parked meetings were eventually diagnosed by reading a
JSON file off somebody's laptop.

Three things follow, and each is a rule rather than a fix:

- **The client reads the field the gateway sends**, keeps the status in the
  sentence (so a captive portal's reply is still tellable apart from a refusal
  this gateway composed), and carries the status as a number for a log line.
- **A drain reports its refusals** (`DrainReport.refusals`) and the shell logs
  each one: session id, kind, status, contract code and the gateway's own
  sentence — never a segment, a note, a title or the credential. The queue
  entry's `lastError` is the right place for a *person* to read it and the
  wrong place for anybody to find it, because an entry that is later accepted
  takes its own explanation with it.
- **No screen shows a person an HTTP status.** `rejectionNotice` maps the codes
  whose recovery is something a person does, and falls back to the gateway's
  own words — deliberately, because a refusal this app has never seen before is
  exactly the one worth quoting.

**And a refusal never un-says a note that landed.** The meeting detail page
checked `record.rejection` before `session.notePath`, so one refused *later*
write made a meeting whose note had been in the bucket for ten minutes read
"This meeting has not left the device — gateway answered 400". Two contradictory
claims about one meeting, and the newer one was the false one. The path decides
which sentence is true; a refusal is said underneath it, and content still
waiting on the device is said underneath that. **The test that fails if this is
reversed** is `A REFUSAL AFTER THE NOTE LANDED DOES NOT UN-SAY THE PATH` in
`apps/mobile/__tests__/meetingsScreens.test.ts`.

### The folder is a setting; the question is not

Mail, calendars and Chat each carry an editable destination per connection.
A meeting carried `MEETINGS_FOLDER` — a constant — interpolated into a
paragraph on the settings panel, with no control beside it and no setter
anywhere in the codebase. Somebody who files meetings under `2-areas/meetings`
had to move every note by hand, forever.

The panel's own docstring defended that absence, and the argument it used was
right about something else: the destination is **asked for every time, before
the microphone opens, precisely so that no remembered setting can answer it
silently**. That is a rule about *which context* a meeting lands in, and it is
untouched — the first offer is still always the person's own workspace, the page
they are standing on is still offered second with its audience named, and the
sheet still opens. What was neither asked nor settable is *which folder the
first offer points at*. Two decisions; conflating them is why the setting did
not exist for as long as it did.

So `workspaces.meetingsFolder` is optional, `setMeetingsFolder` is owner-only
and personal-only (only the personal-inbox offer reads it, so on a shared
workspace it would be a control with no effect), and the value rides to the
sheet on `DestinationContext` — where it belongs, because `ownPersonalContext`
already finds the one context the setting is about, and a parallel argument
would be a second thing every caller has to keep pointed at the same row.

Three things hold it honest:

- **The validator is the gateway's own.** `setMeetingsFolder` runs
  `normalizeMeetingFolder`, the same function that decides whether a folder a
  client asked for is one the write will accept. Validating any other way would
  let somebody save a folder the gateway then refuses — a setting that appears
  to work and files somewhere else, which is verbatim the defect
  `features/meetings/destination.ts` exists to prevent, arriving through
  settings instead of through a request.
- **A stored folder this build would not file into is treated as absent.**
  `inboxFolderOf` falls back to `INBOX_FOLDER` rather than offering it. An
  offer with no `refusal` on it is a promise, and a row written by a newer
  control plane — or one predating a rule this bundle ships — must not produce
  a destination whose write is rejected. The phone cannot import
  `packages/meetings`, so the check is `fileableFolder`, the restatement this
  module already keeps, and the agreement test is what holds the two together.
- **Clearing stores nothing, not the default's spelling.** A stored
  `0-inbox/meetings` would stop following the default if it ever moved, pinning
  somebody who never expressed a preference to a decision they did not make.

**What a "simplification" would cost**: honouring the stored value without the
fileable check turns a settings typo into meetings that never land, with the
failure surfacing at the write rather than at the field. Dropping the
personal-only gate puts a control on a workspace that nothing reads. Letting
the setting answer *which context* — rather than which folder — drops a
transcript of a conversation somebody has not read yet into a bucket their
colleagues are watching, which is the one thing this whole seam was built to
stop.

**The tests that fail if any of it is reversed**: `where the first offer points
is the workspace's own setting` in `apps/mobile/__tests__/meetingsDestination.test.ts`
(seven checks, including every folder the real `normalizeMeetingFolder`
refuses), `apps/convex/__tests__/meetingsFolder.test.ts`, and
`apps/mobile/__tests__/meetingsFolderPanel.test.ts` for the panel's own gating.
## The seventh key became a row in the `+`, and the route it guarded did not move

Everything above about "the seventh key" describes a microphone at the end of the
phone's bottom row. On 2026-09-19 the owner removed it: *"we no longer need a
dedicated mic button on the bottom row, just a plus button that opens different
options"*. The row is six keys, the separator that marked the key off is gone
with it, and **recording a meeting is a row in the sheet the `+` raises**
(`CreatePrompt`, driven by `files/createSheet.ts` — see
[app-and-console](./app-and-console.md), *Nothing is named before it is written,
and the phone's `+` is the only key*, and *The corner makes five things* above
it, which is where the corner's own list is argued).

What that costs and does not cost, because this file spent a lot of words on that
key:

- **The route survives.** Everything argued above rests on the phone having *a*
  way into capture and on the only route to a finished meeting hanging off the
  sheet that way raises. The `+` raises the same flow (`startMeetingFlow`), so
  both still hold — one press deeper, and now beside the four other things
  somebody starts.
- **The "one microphone" rule survives, and was never about the glyph.**
  `NoteEditor`'s `microphoneElsewhere` still stands the floating microphone down
  while the bottom row is on the glass, and the floating one still returns with
  the keyboard accessory bar, at exactly the moment there is a caret. The
  condition is unchanged because what it protects is *the corner* — one floating
  control at a time — and the row's `+` is that control now.
- **The `+` had to stop being gated on `canEdit`.** It was, while it meant
  *note*. A meeting is something a member of somebody else's context can still
  start, so that gate would have taken capture off every shared context somebody
  reads — which is the hole this file's own argument exists to keep shut. The
  read-only rule moved a row lower: the sheet draws no Note, Drawing or Folder
  without `canEdit`, and `canCreateAnything` hides the key only when the sheet
  would have no rows at all.
- **The width argument gets easier, not harder.** Seven targets plus the rule
  needed 309pt and spent the pill's padding and part of the sliver at 375 and
  below. Six need less, and `bottomRowWidth.test.ts` keeps the seven-key solve as
  a probe of `BottomBar` — the shape the geometry must survive if a destination
  is ever added back — separately from `CONSOLE_KEYS`, which is what the product
  draws.

**The tests that fail if it is reversed**: `is six keys, ending at Save, with no
separator and no microphone` in `apps/mobile/__tests__/bottomRowWidth.test.ts`,
`the app's other place is a row in the + sheet, and choosing it records` in
`apps/mobile/__tests__/consoleChrome.test.ts` (driven through the real row, to a
real refusal from a console with no controller behind it), and the four states of
`apps/mobile/__tests__/oneMicrophone.test.ts`, every one of which is unchanged by
this — which is the point.

## A permanent, correct refusal is not the same fact as a transient one, and must not share its sentence

Verified on hardware: a meeting killed mid-recording with real audio recovers
on Retry in about seven seconds and files correctly; the same kill with
nothing captured — no transcript, no typed notes — cannot file, and should
not. Both are the intended behaviour. What was wrong was what the second one
was told: `markSyncFailed` parked every record that failed to reach the
gateway six times behind one sentence — *"This meeting has failed to reach
your context several times. It is still on this device — try again, or copy
your notes out."* — regardless of whether the record held anything a retry
could ever send or a copy could ever find.

Six transient failures is a fact about the **connection**. It says nothing
about whether *this* meeting has content worth fighting for, and a session
`hasNothingCaptured` has none: there is no request a retry could make succeed,
and there are no notes to copy out. Telling somebody to try again for a
meeting that will never file, or to copy notes that do not exist, is the same
shape of lying instrument as a level meter that always reads zero — technically
produced by real code, answering a question nobody asked instead of the one in
front of them.

**The fix is a classification, not a new behaviour, and `markSyncFailed` now
makes it explicitly:** the same trigger (`MAX_SYNC_ATTEMPTS` transient
failures), a different sentence depending on `hasNothingCaptured(record.session)` —
the honest, permanent "nothing to send and nothing to copy out" for an empty
session, and the original retry framing — now carrying the refusal's own last
reason rather than a bare count of attempts — for everything else. This is a
backstop rather than the primary fix: `end()` and `recoverInterruptedRecordings`
both keep a session with nothing captured out of the sync queue in the first
place by folding it straight to `empty`, and `MeetingNoteScreen`'s `Landing`
checks `session.state === "empty"` before it ever reads `record.rejection` — so
a session that took either path never reaches this message. It exists for the
same reason `convexGateway.finalize`'s own defensive `hasNothingCaptured` check
does: a bug in an earlier step should not turn into a false "try again" here,
any more than it should turn into a real, empty note in somebody's bucket.

**The primary fix was `recoverInterruptedRecordings`, which had not been taught
the check `end()` already makes.** A killed-mid-recording session found
`recording` or `paused` at the next launch was folded to `failed` with
`INTERRUPTED_RECORDING_REASON` — *"This device restarted while recording, so
the rest of this meeting was not captured. What was recorded is kept
below."` — unconditionally, whether or not there was a "rest" or anything "kept
below". For a recording killed within the first few seconds, before a word was
typed or transcribed, that sentence asserts content the session never had, and
`failed` itself reads as transient — Retry is right there — when the true fact
is permanent: `MEETING_TRANSITIONS` puts `empty` only behind `finalizing`, the
same two-event path (`end`, then `empty`) `end()` already takes, so this is
that same path reaching the one caller of `fail` that had been left out of it.
A session with nothing captured now closes the same way whichever door it
came through — the ordinary end of a meeting, or a relaunch that finds one
still open — and `INTERRUPTED_RECORDING_REASON` is left to say what remains
true of it: a session that captured *something* before the device restarted.

**`hasNothingCaptured` is not the whole question, and the fold has to ask the
other half.** It reads the session — no transcript, no typed notes — and a
meeting recorded entirely offline satisfies it while holding everything it
has on disk: no chunk has reached a transcriber yet, and the person was
listening rather than typing. `empty` is terminal, so folding such a session
to `empty` refuses every word that audio later comes back as, which is
precisely why `end()` asks `hasNothingCaptured` **and** whether the spool is
holding anything for this meeting before it folds. Recovery at launch is a
second caller of the same question and needs the same second half of it;
counting only the session is a guard holding the right rule against the wrong
field. The counts are already taken by `configure` before recovery runs — for
`recoverStaleFinalizes`, which needs them for its own reason — so this costs
nothing but the condition. **The test that fails if it is reversed** is `a
meeting killed with only its audio is failed, not called empty` in
`apps/mobile/__tests__/meetingsKeptAudio.test.ts`, beside the typed-a-line
case it was hiding behind.

`markSyncFailed`'s copy is the one place that still asks the session alone,
and it is left that way deliberately: `record.ts` is pure and holds no view
of the spool, threading one in to reach a backstop behind two folds that
already check it buys a sentence, not a word of transcript. The residue is
therefore exact and small — a meeting whose only audio has been *set aside*
after three refusals is not `audioHeld`, so it can still reach this path and
be told "nothing was captured" while a chunk of it sits on the device. The
screen says otherwise right beside it (`endedAudioLine` counts set-aside
audio), and the state it is in is not terminal, so nothing is lost; it is a
wrong sentence, not a wrong fold. Worth fixing the day `record.ts` has a
reason to know about audio, and not before.

**What is not changed.** No code path that had a retry worth making loses it:
a `failed` session with real content still gets `INTERRUPTED_RECORDING_REASON`
and its Retry, unchanged. The finalize deadline (`checkFinalizeTimeout`,
`FINALIZE_TIMEOUT_MS`) is untouched; this is a different caller of `fail`, and
`recoverStaleFinalizes` was not audited to need the same check because a
session that reached `finalizing` at all had a `start`/`resume` behind it and
`pendingSteps` would already have queued real content ahead of any finalize.

The checks are `six failed reconnections on a meeting with nothing in it
never say 'try again'` and `six failed reconnections park a meeting and say
so, carrying the real reason` in `apps/mobile/__tests__/meetingsSync.test.ts`,
and `a recording killed within seconds — nothing captured — is empty, not
failed` in `apps/mobile/__tests__/meetingsController.test.ts`.

## The engine's own evidence travels to the recorder, because a Worker's log is not a place a person can read

The silence refusal above works and does not finish the job. Measured on the
signed build, in the same room, with nobody speaking:

```
before the refusal:  166 words / 90s = 1.84 words/sec
after  the refusal:   29 words / 45s = 0.64 words/sec
```

A threefold cut and a meeting still filed, so `hasNothingCaptured` is still
unreachable and the acceptance — record silence, expect no note at all — still
fails. The next move depends entirely on one question: **do the surviving
segments sit just past the thresholds, or far from them?** Just past means the
threshold is wrong and moving it is cheap. Far from them means the engine
decoded silence *confidently*, no threshold reaches it, and the answer has to
come from somewhere else.

**Nobody could answer it, and that is the defect this section is about.** The
three numbers that decide it — `no_speech_prob`, `avg_logprob`,
`transcription_info.duration_after_vad` — were read inside
`infra/transcribe-worker`, used for control flow, and dropped on the floor. The
transcript segment that reaches the customer's bucket carries exactly
`id, startMs, endMs, text, speaker, channel, confidence`, and measured across
every segment of every meeting, the distinct set of `confidence` values is
`[null]` — not a low number, `null`, because **the deployed model does not emit
a field called `confidence` at all** and this repository refuses to manufacture
one. So the one numeric field on the wire is structurally empty, and the three
fields that are not empty were invisible.

### First: the provider does return them

This was established before anything was built, because the alternative finding
— that the fields are absent — would have made plumbing them a waste and the
correct answer would have been to say so loudly.

- **The published output schema of `@cf/openai/whisper-large-v3-turbo` carries
  them**: `segments[].{start, end, text, temperature, avg_logprob,
  compression_ratio, no_speech_prob, words[]}` and
  `transcription_info.{language, language_probability, duration,
  duration_after_vad}`. It carries no `confidence`, which is why that field is
  `null` everywhere and always will be on this model.
- **They demonstrably arrive**, which is stronger than a schema. Rule 1 cannot
  fire on this deployment at all — `vad_filter` defaults to `false`, so
  `duration_after_vad` equals `duration` and the rule has no opinion — so the
  threefold reduction measured on hardware was produced *entirely* by rule 2,
  which reads both `no_speech_prob` and `avg_logprob` and fires only when both
  are present. A rule that cannot fire without two fields, firing repeatedly on
  real audio, is those two fields arriving.

So the finding is that the evidence is real and was being discarded, and the fix
is to carry it rather than to declare it missing.

### Where it lives, and the two places it may not

**On the segment: no.** A segment is written into the customer's note and
rendered at a person. A `no_speech_prob` beside a sentence is a number whose
meaning its reader has no way to know, attached to their own words, in storage
they own — and `A CONFIDENCE IS NEVER INVENTED` exists precisely to keep numbers
that look like judgements about somebody's speech out of that file.

**In a log the transcription service keeps: no**, and this is the one the defect
proves. That Worker's logs are in an account the person diagnosing a recording
does not have. Tonight that person was on the machine that made the recording,
holding the app and the bucket, and the numbers were two hops away in a place
they could not reach. A diagnostic in an inaccessible place is not a diagnostic.

**So: a per-chunk summary, on the wire, to the recorder that posted the audio.**
`SpeechEvidence` is counts and readings — how many segments came back, how many
stated each field, the extremes over the kept population and over the refused
one, and the two `transcription_info` durations. The gateway carries it beside
`refusedSegments`, reading it key by key and judging nothing, exactly as it
already carries the count. The desktop writes one structured line per answered
chunk, `meeting_speech_evidence chunk=… kept=… refused=… …`, in the process the
person diagnosing already has in front of them.

Four properties, each load-bearing:

- **It is a summary, never a per-segment array.** A number beside each utterance
  could be joined to what was said, and would eventually be rendered at
  somebody. Counts and extremes cannot be joined to anything.
- **It carries no text, no timings and no ids of anybody's words.** Every value
  is a number or `null`; the only string in the log line is the client's own
  `chunkId`, which names a meeting and a channel and no content. Both the
  gateway and the desktop rebuild the object from keys they declare rather than
  forwarding what arrived, so a field the far end grew does not ride along.
- **`null` means the engine did not say, and `0` is never substituted for it.**
  This is the whole point: a `no_speech_prob` of `0` reads as "the decoder was
  certain somebody was talking", and an engine that stated nothing must never
  produce that sentence. The line prints `absent`, which cannot be misread as a
  measurement. A whole answer with no evidence prints `evidence=absent`.
- **Nothing is put in front of a person.** The sentence a person needs already
  exists and is words rather than numbers — `CAPTURE_NOTICES.silent`, said only
  when a whole chunk came back empty. No screen and no note gains a number here.

The extremes are **independent per axis**, and that is how they must be read:
`keptNoSpeechMax` and `keptLogprobMin` may belong to different segments. They
bound the surviving population rather than describing one member of it, which is
exactly the question being asked — did anything survive anywhere near the
cutoff, or is the whole population far from it.

### What is deliberately not plumbed

**The control plane's path.** The phone and the browser transcribe through
`apps/convex/functions/meetings/transcribe.ts`, which carries `refusedSegments`
and could carry this too. It does not, for the reason that decided everything
above: nothing on the phone can read a log line, so the evidence would land in
Convex's logs — the same inaccessible place, one provider along — and a field
nobody reads is plumbing that rots. The desktop is the recorder being
diagnosed, and it is where the numbers can actually be looked at. When the phone
grows somewhere to put one, the field crosses the same way.

**Any use of the evidence in code.** Nothing branches on it, on any hop. The
refusal stays exactly where it is, on the engine's own fields, in the one place
every recorder's audio passes through. This is a diagnostic and must not quietly
become a second threshold in a client.

### The cost, stated

One short line per answered chunk, so roughly three a minute per open channel,
in the desktop's log for the life of a recording. Always on rather than behind a
flag, deliberately: the evidence is wanted *after* a recording turns out wrong,
and a diagnostic somebody has to switch on beforehand is one nobody has when it
matters.

**The test that fails if this is reversed:** `reporting the evidence the refusal
acted on` in `infra/transcribe-worker/src/transcribe.test.ts`, `the engine's own
evidence reaches the recorder` in `apps/mcp/test/meetings.test.mjs`, and the
evidence block in `apps/desktop/test/transcriber.test.mjs`. Filling a `null`
reading with `0` reddens six checks in the Worker alone.

## A build is what shipped, not what merged — two "the fix did not work" reports were one build

Two defects were reported against the signed build the owner installed on
2026-09-08, and both dissolve into the same fact.

- **The eight parked outbox rows did not clear**, though `dropMisaddressed` runs
  over the queue as it is read off disk and drops exactly those rows.
- **Every segment was delivered to the page more than once**, at a ratio equal
  to the meeting's index in the run — one subscription leaking per meeting.

The build is workflow run `34181715875`, whose `head_sha` is `fd0081e` (#351,
the silence refusal), started at `02:55:14Z`. `dropMisaddressed` and the
controller's detach both landed in `7bc99ca` (#353), which merged at `03:00:52Z`
— **five minutes and thirty-eight seconds after that build started**. Neither
fix was in the binary. The dispatch message named #353 as carried because it was
sent after the merge was requested and before it landed.

Both reports are therefore correct observations of the *old* code, and both were
reproduced against `fd0081e` and shown absent on `main`: three meetings driven
through the real controller against the old commit deliver meeting N's segments
N times and leave each meeting's record holding every later meeting's words; the
same run on `main` delivers each exactly once and leaves the recorder's
subscription count back at zero between meetings.

Two rules follow, and the first is the durable one:

- **A fix is confirmed against the binary that was installed, never against the
  branch that was checked out.** The report that confirmed #353's leak fixed did
  so by reading `controller.ts` in a working tree — on a machine running a build
  that did not contain it. Reading the source proves what will ship; only the
  build proves what did. A dispatched workflow's `head_sha` is the fact, and it
  is one API call.
- **The queue is the evidence either way.** "No new parked entry appeared" was
  read as the leak being fixed, and "the outbox stayed at 8" as the drop not
  working. On the build that actually ran, those are one sentence — nothing
  dropped them because the code was not there — and the pair should have been
  read together rather than as two findings.

**What clears the parked rows:** any build cut from `7bc99ca` or later. They are
dropped once, on the way in, the first time that build reads the queue, and it
logs `meeting_segments_misaddressed_dropped rows=<n>`. Nothing is lost — each of
those rows also went out under the meeting that produced it and was acknowledged
there.

### The leak's third instance, and the guard the comment described

The recorder-to-bridge attachment in `apps/mobile/features/meetings/capture/
desktop.ts` is **correct, and was**. Its own `attach()` docblock states the
hazard in the words the third report used — *"a recorder is created per
configuration and `stop()` must genuinely detach, or a second meeting is fed by
two subscriptions and every segment is emitted twice"* — and the only check
standing on it ran **one** meeting, which is the single length at which a
per-meeting leak is invisible. A comment describing the failure it sits above,
with no test at that length, is how the same shape gets reported three times.

So the guard is now where the comment is: three meetings in one run, each
segment delivered exactly once, and the recorder's subscription count asserted
back at its baseline after every `stop()` — the stricter half, because a fix
that halved a leak passes a delivery count and fails a baseline. The overlapping
`start()` race is checked too, which is the one path where `attach()`'s opening
`detach?.()` is reachable at all; deleting that line failed nothing in the app's
whole suite before it.

**Three instances of one shape** — controller-to-recorder (#353), the phone's
equivalent, and this comment's hazard — say the answer may be structural rather
than three fixes: one attach/detach helper that owns a subscription set, or a
check that every subscription taken in this subsystem is released. That is a
larger change than the pull request making this note, and it is proposed here
rather than built.

### A meeting that stops saves itself, and says so where somebody is looking (2026-09-21)

**Reverses "a note the person never agreed was over"**, decided by the owner
after losing one: *"if a meeting ever stops it should IMMEDIATELY be saved, no
button press needed"*, and *"it should be very LOUD and dramatic if something
went wrong so the user can resume/restart"*.

**What was lost, and how.** A 31-minute meeting, ended normally. The gateway
*accepted* the finalize and answered with no note path — a real state, "I have
it, the bucket does not yet", while an enhancement runs. That ack sets
`acked.finalized`, so `pendingSteps` correctly offers no finalize step, and
`sync.ts` recorded that the path "arrives through the list". Nothing in this app
has ever called `gateway.list()`. The only thing left that could ask again was
`recoverStaleFinalizes`'s retry branch, and it went through `retrySync`, which
returns the record **unchanged** when there is no `rejection`. Ten minutes of
nothing, ten more, then `failed` — parked forever, with the words on the device
and a note that may well have been written. The console panel's one flat
sentence about it was the last link in the chain, not the defect.

So: `reopenFinalize` is the one place that question is asked, and it clears the
ack. `retryFinalize` already had that half and said in its own header that
without it the method "does nothing at all in the case it exists for"; the
automatic retry beside it never got it. **Two callers of one question is the
shape of this defect**, and the rule it leaves behind is that a recovery path
and the button beside it are the same function or they will drift.

**Why `fail` became `end` for an interrupted recording.** The old argument was
symmetrical-sounding and is not: *finalizing unasked writes a note the person
never agreed was over* versus *parking it leaves a meeting reachable by
nothing*. A note is editable, movable and deletable the moment it lands, and it
is in the customer's own storage where every other thing they own already is. A
parked meeting is behind a Retry nobody knew to press. The costs are not
comparable, and the reported failure is the second one. The other half of the
old argument — "a meeting merely interrupted may well continue" — is answered by
*resuming* the meeting, not by withholding the note in the meantime.

This is strictly better for the offline case, which was not the point but is
worth recording: `sync()` already holds a `finalizing` meeting while its audio
is on the device, so a recording killed with nothing but audio on disk now waits
for its words and is filed **with** them. Under `failed` that same audio landed
in a session nothing was ever going to file.

**`interrupted` is client-local and is never written into the note.** "Your
phone restarted" is a fact about our software on a particular evening, not about
somebody's meeting, and they should not have to delete it out of their own file.
The app says it; the note does not.

**Loud is a bar, not a toast, and it has no dismiss.** `Toast` is eight seconds,
tuned for an undo somebody is already looking at. A meeting that did not save is
still not saved eight seconds later, and a notice that removes itself can be
missed by being in another room. `StrandedBar` is up while the meeting is
stranded and goes when it is filed or discarded — the two things that make it
untrue. **The Retry is on the bar itself**: the whole failure is a person who
did not know there was anything to press, and putting the press three screens
behind a notice is the same bug with a sentence in front of it.

It stands down while anything is recording. `RecordingBar` holds that exact slot
and `zIndex` cannot arbitrate between two stacking contexts — and somebody
recording *now* is the one person who must not be pulled away from it. A meeting
that failed an hour ago will still have failed when they stop.

**What "stranded" means is derived, not re-decided.** `meetingNeedsAttention` is
`meetingLanding(record)?.retry != null` — "somebody has to do something" and
"there is something for them to do" are the same fact. A meeting on its way is
not stranded, or the bar would be up after every meeting anybody records; a
session that captured nothing is not stranded either, because nothing was lost.
The list badge takes the same answer: a refused meeting keeps `finalizing`, so
the list used to spell it "Finalizing" in the warning tone, identical to one a
second from landing.

**What a "simplification" would cost.** Reading `stranded` as "has no note path"
puts the bar up after every recording and teaches people to ignore it. Routing
both Retries to `meetings.retry` sends a sync retry at a finalize that never
completed. Dropping the stand-down draws two bars in one 66pt of glass. Going
back to `retrySync` in the recovery path restores the defect this section
opens with, and the check that fails is `the retry actually asks the gateway
again, rather than stamping a clock`.

**Still open, and deliberately a separate change:** resuming a meeting into the
same note. The client state table allows `failed -> recording` and nothing emits
it; the gateway short-circuits a finalize on an already-complete session rather
than rewriting the claimed path, which is what keeps a crash-retry from forking
somebody's bucket into near-duplicates. Continuing a meeting therefore needs a
way to tell a retry from a continuation, and that is a gateway decision with the
customer's bucket on the other side of it.
