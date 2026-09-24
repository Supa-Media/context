# App and console — search and autosave

### The palette is a navigator, the search page is a place, and one row joins them

The command palette answers *"take me to that note"*: ten rows, no scrolling,
gone the moment you press Enter. It is very good at that and it is the wrong
shape for the other question people bring to a set of notes — *"what do we know
about the review cycle"* — where the reader has no destination in mind, needs to
read several results next to each other, will narrow the scope halfway through,
and will open one, read it, and come back. Every one of those wants a URL, and
none of them survives an overlay that closes on the first press.

So `/console/search` exists and the overlay keeps its ten rows. What joins them
is one row at the bottom of the palette's own list.

**A row, not a button in the chrome.** The chrome is not on the path a keyboard
takes: a "See all results" button beside the input is reachable by a mouse and
invisible to the arrows, which is the same defect as a control drawn where a
phone cannot see it. As the last row it is in the one flat list that `selected`,
the wrap-around and the scroll arithmetic all walk — ↑ from the top reaches it
in one keystroke, and with nothing matching it is the only row there is, which
is exactly when "Enter opens the search page" is unambiguously what somebody
meant. **Enter elsewhere still opens the highlighted note.** The obvious wrong
implementation makes Enter always open the page; it looks correct until somebody
presses ↓, which is why `paletteRender.test.ts` moves the highlight before it
presses Enter.

The synthetic row is intercepted inside the palette rather than handed to
`onChoose`. A palette that leaked its own sentinel id to callers would have
every caller writing the same guard, and the one that forgot would try to open a
note named after it.

**The handoff carries the query and deliberately not the scope.** The palette
searched the context you are standing in; the page defaults to every context you
can reach, because that is the question the page is for. Narrowing back to one
is a chip away and lands in the URL when you do it.

### The search page's state is its URL, and that is a trade taken on purpose

`/console/search?q=review%20cycle&in=seyi,lk`. The route holds no state of its
own: the pane reads the query and the scope as props and writes them back
through the router. Typing `replace`s and changing the scope `push`es — pushing
a history entry per keystroke would make Back a way to delete letters, while
going back to the previous scope is a real thing to want.

The cost is that the words somebody typed are in browser history, in anything
they paste, and in any referrer a link from the page sends. It is worth it: a
search page that cannot be reloaded, linked, or returned to after opening a
result is a modal wearing a URL, and those are three of the four things people
do with one. What makes the trade defensible is that it is bounded to text a
person deliberately typed into a visible field — the *cursor* beside it carries
a fingerprint of the query and never the query, because nobody reads a cursor
and nobody chose to put one anywhere. See `docs/decisions/search.md`.

**The scope is slugs and never workspace ids.** `?in=seyi,lk` is the console's
own public addressing, the same as `/console/@seyi`, and a URL somebody may
paste into a chat should not carry database identifiers. It also degrades
usefully: a slug the recipient cannot reach resolves to nothing on their side,
exactly as the server drops an id they cannot search, so a shared link narrows
to whatever the reader can actually see rather than erroring.

### Four ways to have no results, and each is a different sentence

A page that spans several contexts has more ways to be empty than a palette
does, and collapsing them is how a search tells somebody their notes are not
there when nothing looked:

- **Nothing is searchable** — no context this person can reach has fast search
  on. `eligibleCount: 0` comes back from the server for exactly this, and it
  outranks even "type something to search", because there is nothing to type
  into. The copy points at the setting.
- **The scope was narrowed** to contexts that had nothing. Widening is one press
  away and the sentence says so.
- **Everything was searched and nothing matched** — the only case where "no
  matches" is true.
- **Part of it could not be reached** — results from four contexts and a timeout
  on the fifth, which is neither "no matches" nor a failed search. It is a
  partial answer with a retry beside the row that failed, and the retry is the
  same blended call narrowed to that one context, so it goes through the same
  authorization and the same filter.

A context whose index is still catching up gets its own line for the same reason
the palette has an `indexing` state: a blended list is where "this context said
nothing" is most easily misread as an answer, because the other contexts
answering makes the silence look like a result.

They are one enum in `features/console/search/results.ts` rather than a chain of
ternaries in the pane, so each case is named, tested, and a fifth cannot fall
silently into the "no matches" arm.

### Search is in the app's navigation, and it disappears only on a measured zero

It is app level rather than a context's, because the question spans contexts — a
Search *inside* a context would default its scope to that one, which is the
search that already lives behind the palette.

The row is drawn only where something would answer it: a person whose contexts
all have fast search off has a destination that can only apologise. But
`appSectionsFor(undefined)` **draws** the row, and that asymmetry is the rule.
The eligible count arrives from a Convex query a beat after the first paint, so
treating absence as zero would make Search flicker into existence on every load,
and a navigation item that appears late is one people learn not to look for. It
also keeps the demo console and the reachability registry honest: neither has a
live query behind it, and neither should have to fake one to draw the app's own
navigation.

### The console autosaves, and the prompt that is left is about a decision

The editor had one route from a draft to the customer's bucket — the Save
button, or ⌘S — and three separate interruptions arranged around it: a refusal
to open another note, a confirm before closing a tab, and the browser's
"leave site?" on every unsaved draft. The owner's words for that: *"it's
something people are used to already in every note taking app, so it's so
necessary, stop bugging people to save."*

**Two timers, and the second one is not decoration.** The draft is written
`AUTOSAVE_IDLE_MS` (2s) after it stops changing, and at latest
`AUTOSAVE_MAX_WAIT_MS` (15s) after the first edit of a burst, whichever comes
first. An idle-only debounce is the obvious design and it never fires for iOS
dictation, which inserts a partial result every few hundred milliseconds — a
dictated paragraph would sit unwritten for as long as somebody kept talking.
The ceiling is measured from the first edit and is not pushed back by later
ones, or it is a second debounce.

**The numbers are a cost decision, on somebody else's quota.** One save is a
Convex action → the gateway → one conditional PUT against the customer's bucket
plus a LIST to refresh the note's folder: two requests. At these intervals
ordinary composing costs about what the Save presses it replaces did, and
continuous input is bounded to four saves a minute. A save per keystroke is the
version of this feature that is not shippable, which is why the scheduler is a
module with its own tests rather than an effect.

**What autosave refuses is the whole safety argument** (`autosaves` in
`editor.ts`, asked again when the timer fires rather than trusted from when it
was armed):

- **`conflict`, never.** The draft is based on an etag somebody else has moved
  past. Writing it automatically is a refusal every two seconds against a
  bucket that does conditional writes, and a **silent clobber** against one
  that can only read-compare. The three answers in `ConflictResolver` stay the
  only way out, untouched.
- **`error`, once and no retry loop.** A save that failed for a reason nobody
  has read does not get retried every two seconds. It re-arms by itself the
  moment somebody types, because `edited` moves `error` back to `dirty` — what
  every editor does, and why there is no retry logic.
- **`queued`**, because the offline queue already holds the newest text and
  supersedes; and anything read-only, clean or already in flight.

**Every autosaved write is the same conditional write Save makes**, carrying
the etag the draft was typed against. There is no force flag, no unconditional
branch and no second write path in `useFileBrowser`. Relaxing this is how
autosave becomes the feature that quietly overwrote somebody's Obsidian.

**The scheduler hands back the path it was armed with, and the caller compares
it.** `autosaveNow` reads the text and etag off the editor, so a timer that
fired after a note switch without that comparison writes **the new note's text
to the old note's path, against the new note's etag** — a conditional write the
server has every reason to accept. The reachable sequence is not exotic: the
read for the next note is a round trip, and typing during it arms a timer for a
note that is about to be replaced.

**Allowing navigation during a save is what made the settlement path-aware.**
The editor reducer describes the *open* note, and until now nothing could leave
a note with a write in flight, so `saveSucceeded`, `saveFailed` and
`saveTimedOut` could be dispatched blind. Each is now gated on the editor still
holding the note the write was for — a late success would otherwise mark
another note's real draft clean against an etag it was never based on — and the
save generation and its timeout are keyed by path so two writes in the air
cannot discard each other's answers. A save that ends for a note nobody is
looking at reports itself in the notice line, naming the note and saying its
draft is on the device.

**`guardLeaving` keeps exactly one job: `needsDecision`.** A conflict and a
failed save are the states nothing writes for you, so they are the only ones
worth interrupting somebody for. Everything else is flushed on the way out:
`select` writes what is pending before the selection moves, closing a tab does
the same by path (`closeIntent`), and on web `visibilitychange`/`pagehide`
flush while `beforeunload` prompts only for the two. That last one makes the
prompt *better* rather than merely rarer — browsers increasingly decline to
show it for a page that always asks, so asking on every draft was spending the
browser's patience on the case that was never in danger.

**The flush is best-effort and is not the guarantee.** A write issued from a
page being torn down may not leave the machine. What makes a draft safe is
`features/offline`: every keystroke is on the device, and `restoreFor` puts it
back — as a conflict if the bucket moved on — when the note is reopened.

The copy follows the behaviour, because a status line that still says "Unsaved
changes" over a draft that is being written is the same nag in a smaller font:
"Saving soon" (quiet) → "Saving…" → "Saved in your bucket", and a resting
button that says "Saved" rather than offering a dim "Save". It still says
"Save" over a body read off the device, where "Saved" would vouch for a bucket
nothing has spoken to.

**What a reversal costs, and the tests that fail.** Dropping the ceiling loses
dictation entirely (`autosave.test.ts`); autosaving a conflict is a clobber
somebody was never shown (`autosaveEditor.test.ts`, twice over); dropping the
path comparison writes one note's words into another file
(`autosaveEditor.test.ts`, "a timer armed for one note cannot write into
another that is also dirty"); dropping the path check on a settlement marks a
real draft clean (`saveTimeout.test.ts`). One guard is recorded in
`autosaveEditor.test.ts` as *not* covered rather than quietly claimed:
`performSave` cancelling the timer it supersedes is redundant with the
fire-time `autosaves` check, and nothing can distinguish the two.

### Reassurance is a chip in the top bar; a decision is a button over the note

Autosave removed the *reason* for the Save button and left the button. The
report, from somebody writing a note:

> whenever I type in the note, this big ugly save button appears, any way where
> it can not appear there and just show in the top right where it shows "R2
> managed" that its saving or failed to save or something

Both halves are right. `dirty` is the state every keystroke produces, so
"Discard changes" and "Save" appeared across the foot of the document on the
first character and stayed until the write landed — two controls over somebody's
own text, for a write that was already scheduled. Neither was load-bearing: ⌘S
and the autosave timer make the same conditional write, and Discard in `dirty`
could only ever reach back to the last autosave, which is what undo is for. And
the surface that *could* have said it quietly was saying it in the bottom-right
corner, in 11pt grey, between a word count and a bucket name.

**So the two jobs were split by whether a person has to do something.**

- **Nothing owed** — typing, saving, saved, a cached body, a queued draft
  draining on its own — is `saveChip` (`status.ts`), drawn in the top bar
  beside the storage pill and nowhere else. Same words, same tones, same
  details as the strip segment it replaces: "Saving soon", "Saving…", "Saved",
  "Cached copy", "Queued", "Not saved", "Conflict".
- **A decision owed** — a save that failed, a conflict, a queued draft
  somebody may want to let go — keeps `NoteEditor`'s row, with the full
  sentence beside the buttons at *every* density. Those messages are
  paragraphs ("Still waiting on your bucket, so we stopped waiting…") and a
  two-word chip cannot hold one. `editor.ts` has always said the manual route
  must stay reachable exactly where autosave refuses, and it is.

**The claim moved rather than multiplied**, which is the same rule that took
the disabled Save pill off the row and then took the durability sentence off
the pointer layout: one claim, one surface. The strip keeps what is
*measured* — the note's key, the word count, the index, how writes are checked,
the bucket — and gives up the one fact in it that changed while you typed. The
phone is untouched apart from losing the buttons: it has no top bar chip and no
status bar, so the sentence at the foot of the document is still its only save
claim, and Save is still `check` on its toolbar.

**Why the top-right and not somewhere calmer.** It is where the bucket chip
already is, and the two answer one question between them: where the note lives,
and whether it is there yet. It leads that group because it is the only chip in
the bar whose text changes while somebody types, and in a row aligned to the
trailing edge the leading item can grow without shifting its neighbours.

**What a reversal costs, and the tests that fail.** Putting the Save row back
in `dirty` fails "typing puts nothing over the note"
(`offlineEditorRender.test.ts`), which mounts a mid-sentence draft at 1440 and
asserts that neither button is on screen; putting the segment back in the strip
fails "the strip does not carry it" (`status.test.ts`), which is what stops the
console saying "Saved" at both corners at once; dropping the row in `error` or
`conflict` fails "a failed save keeps its Save, and a conflict keeps its
Overwrite", and dropping the sentence with it fails "a failed save explains
itself at a pointer width" — the case that keeps the reason for a failed save
reachable now that the strip no longer carries it as a tooltip.

