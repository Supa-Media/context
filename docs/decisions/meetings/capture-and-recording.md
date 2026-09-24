# Meetings — capture and recording

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
([plugins](../plugins.md)), and a file that only makes sense
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
([privacy-and-sharing](../privacy-and-sharing.md)).

This is worth stating because a meetings feature is where a bypass would arrive
looking reasonable. The desktop app wants a fast recent-meetings list; the
console wants counts; the mobile app wants a badge. Each is a reason to keep a
meetings index somewhere convenient and read it without going through `canSee`,
and the first one that ships that way makes the privacy engine advisory.

The rule that keeps it honest: **the gateway never learns about a meeting from
anywhere but the bucket.** Session metadata in flight is in-flight state
(see [architecture](../../meetings/architecture.md)); a *finished* meeting is a
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
[testing](../testing.md), *a guard nobody has checked is not a guard* — so it is
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
