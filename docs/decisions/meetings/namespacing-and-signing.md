# Meetings — namespacing and signing

### A meeting lands at an ordinary path, and nothing about it is namespaced

`0-inbox/meetings/2026-09-05-<slug>-<suffix>.md`, where `<suffix>` is the
stable tail of the session id. It is an ordinary note under the customer's
ordinary folders: no `meetings/` bucket, no tenant prefix, no reserved
directory, nothing to migrate ([non-negotiable 2](../../../CLAUDE.md)).

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
([non-negotiable 2](../../../CLAUDE.md)) — so there is nothing for a `context`
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
  from notes, like search is derived from files ([search](../search.md)). A
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
