# Meetings — notes and filing

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
([identity-and-access](../identity-and-access.md), non-negotiable 4). This app is
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
