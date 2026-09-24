# Meetings — transcription evidence

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
