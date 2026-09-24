# Meetings — UI surfaces

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

- A phone has **no rail at all** now ([app-and-console](../app-and-console.md);
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

This is not the `App` group returning ([app-and-console](../app-and-console.md),
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
density now ([app-and-console](../app-and-console.md)), so the surviving trigger
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
[app-and-console](../app-and-console.md), *a route with no way in is a route
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
