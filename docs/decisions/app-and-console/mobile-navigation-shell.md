# App and console — mobile navigation shell

### A folder page is a page, and a folder is acted on like a note

Two things a folder link exposed, once one could actually be followed.

**The folder's own listing was thrown away by the root's.** `select` fetches a
folder's listing when it does not have one — which is exactly what following a
team link to a folder does — and `useFileBrowser`'s per-context load finished by
*replacing* the whole listings map with `{ "": root }`. That request is started
first and can land second, because a folder's listing is the smaller one, so the
folder page sat on "Loading…" and nothing retried: the only way back was
expanding that folder in the side panel, which asks again. `takeRootListing`
merges instead. That is safe rather than lenient — forgetting the previous
context is done by the reset at the top of the same effect, before any request
goes out — and the wholesale replace is the tidy-up that reads as equivalent.

**And a folder drew its own pair of controls.** A "Share…" pill in the heading
and a full-width "Make this folder private" beneath it were the first two things
on a folder screen, offering the same two capabilities a *note* offers through a
different pair, in a different place. They are one pair now — a lock and a
share, in the frame's trailing group on a phone and in `BrowsePane`'s note head
on a pointer — and `FolderView` draws neither. What a share *means* still
differs by kind and that stays `ShareDialog`'s to say: `createShare` has no
folder form, so a folder gets the team link.

The lock draws the state a thing **is in** and its label names the state it
moves to, and the disagreement is deliberate: an unlabelled 20pt target can only
show what is true, while a label is read aloud before the press and is worth
more as a verb. Making them agree in either direction loses one of the two
facts. The visibility *sentence* stays on the folder page — it says what `team`
means for the notes inside, which is the one thing a padlock cannot.

### A folder's placeholder is not a row

Object storage has no folders, so `createFolder` writes `README.md` to give the
prefix something to be. That file then appeared as the first row of every folder
the console drew — above whatever anybody had actually written, on the surface
with the least room for it, and on a screen whose whole argument is that a
folder is somewhere you are rather than a settings panel. The owner's report was
"I don't love that creating a folder puts an overview page in it".

**The console does not list it, and the bucket still holds it.** `listedEntries`
drops it and both surfaces call that one function — the tree and the folder
page are one listing shown twice, and a file that is a row on one and absent on
the other is worse than the row it was hiding. `loadedCounts` skips it for the
same reason: that line is read against the rows on screen, so counting a row
nobody can find prints one note more than anybody can go and look at. Obsidian,
`ls`, rclone and the gateway are unchanged, which is the point — the file exists
*for* them.

Three boundaries carry the argument, and each is a test:

- **Never at the root.** The root prefix needs no key to exist, so a `README.md`
  beside `index.md` was put there on purpose — very probably by whoever
  self-hosted the bucket — and hiding it would be hiding content.
- **The open note is always drawn.** A placeholder reached from search, from a
  `[[link]]` or from a restored tab is the thing you are looking at, and a tree
  that draws a selection it does not contain is worse than one extra row. It
  goes back to being unlisted when you leave it.
- **Names, never contents.** A listing carries names; asking the bucket for every
  README on every expand would be a request per folder to decide a row. The
  honest cost is that a folder overview somebody really wrote is hidden too.
  Nothing becomes unreachable — search finds it, a link opens it, Obsidian never
  hid it — and if that cost turns out to bite, the fix is to render the README as
  the folder page's own introduction rather than to put the row back.

The body changed with it. It used to be `# <folder name>`: the opening line of a
note somebody had started, on a file nobody wrote. The only readers left are the
tools the file exists for, and to them an empty overview page reads like a task,
so it says what it is instead — `renderFolderPlaceholder`, exported so the copy
is pinned by a test. `NEW_FOLDER_HINT` still mentions the file at the moment the
folder is made, because a README turning up in somebody's vault that the app
never mentioned is worse than one line of explanation.

What is deliberately **not** changed is the share card. `previewChildrenFrom`
holds at most three names and would waste one on a placeholder, but the argument
in that function is that it adds no filter the privacy engine did not compute,
and a presentation rule is a poor first exception to it. It can move later, as
its own change, with its own test.

### A phone gets a path bar, which is half of the line that was deleted

`BrowsePane`'s own comment argued the breadcrumb off a phone at length, and the
argument is right about one thing and wrong about the other. Right about
**naming**: the note titles itself inside its own text, the visibility is a
Properties row, and a path pinned above the document is a second band of chrome
under a bar that already floats there. Wrong about **navigation**: a folder page
reached by a team link had no route to its parent at all, and the only way to
another folder was the drawer — the one surface a phone makes hardest to reach.
Deleting the row took both halves because they were one row.

`Breadcrumb`'s `pathOnly` is the half that navigates, and it is subtractive
rather than a second design — the same segments and the same press targets,
minus what a phone already says:

- **No leaf.** The next line down is the note's inline title or the folder's
  heading, so a trailing segment is the same words twice.
- **No visibility chip.** A note carries it as a Properties row and a folder
  states it in a sentence directly beneath, both fuller than the brief chip.
- **The context is not a segment, it is the button in front of them.** It was a
  monospace segment, pressable, on the argument that it is not a label but the
  way *up* — without it the bar bottoms out one level short of home. That
  argument survives; what carries it changed.

  **This shipped wrong once and the record of that is the point.** The first
  answer was to *delete* the segment, on the reasoning that the strip above
  already named the context. That removed the duplication and the way up
  together: a top-level folder has no ancestors, so the path row was empty and
  nothing on the screen led back to the root of your own context. A thing that
  is in two places is moved to one, not removed from both — see *The context you
  are in moved to the breadcrumb* below.
- **And it scrolls horizontally.** `3-resources/books/reading-notes/…` is wider
  than 390pt within three segments; wrapping makes the band a variable number of
  rows and ellipsising leaves the segment you are standing next to unreadable.
  `ContextStrip`'s rule, one row down: nothing truncates, the row gets longer,
  the scroll absorbs it.

A top-level folder therefore draws no *segments* — its ancestors are empty — and
the row is the context button alone, which is exactly right: that button is the
folder above it. `FolderView` still takes a `contextLabel` for the root, which
is the one folder with no name of its own: a context's root folder *is* the
context.

**It is built once and handed to two surfaces**, because a note and a folder
scroll in different containers on a phone: `NoteEditor` owns its own scroller so
`NoteAccessory` can anchor to the region rather than ride away with the content,
so anything that must scroll with a note is passed *in* (`pathBar`, beside
`notices`) rather than drawn around it. Two copies of that line is how a control
ends up on one surface and missing from the other — which is what happened while
this was being written, and the note branch simply had no bar.

It scrolls away with the document rather than being pinned: it answers a
question people ask on arrival, and a permanent band costs a line of every note
forever.

**And the drawer this section argues against is now gone entirely**, which
makes the path bar the *only* way between folders on a phone rather than the
better of two. Nothing above changes: every reason it was built is still a
reason, and the one sentence that has stopped being true is "the only way to
another folder was the drawer". The section below is what that removal cost
elsewhere.

### The contexts moved into the scroller, because navigation is not a verb

The context strip was a slot in the phone's floating top bar. Two things about
that arrangement were reported from a phone by the person using it, and they
are one decision:

**A floating bar means the document runs behind it, and navigation has not
earned that.** The frame's shape at `compact` is deliberate — a full-bleed
document with chrome lying over both ends, so the first line can be scrolled out
from under the top and the last out from under the toolbar. The bottom toolbar
earns its place there because its keys are verbs about the note in front of you,
and a verb you cannot reach is a verb you do not have. A row of context pills is
not a verb about anything: it lay across the twentieth line of somebody's note
at every scroll position, with no scroll position that clears it. "The top
workspaces should scroll with the note; to change workspace I should have to
scroll up."

**And it said the context twice.** The strip named the current context one line
above a breadcrumb whose first segment named it again — on a 390pt screen, two
of the few rows it has.

So the contexts went to where the path already was. `features/console/NavBand.tsx`
is the band: the contexts on top, the path under them, both inside whatever
scroller the surface owns — `BrowsePane`'s on a note or a folder,
`EditorRegion`'s on Map, Connections and Settings. It scrolls away with the
document and comes back by scrolling up, which is what was asked for. The
duplication is gone because the band names the context in exactly one place, the
lit pill, and the path below starts at the first folder.

Three consequences that are decisions rather than placement:

- **The context you are in moved to the breadcrumb, and the strip is what you
  can switch *to*.** `stripOrder` drops the current context; `CurrentContextPill`
  draws it at the head of the path row, as the same pill object, and pressing it
  opens the context's **root** (`browseHref`, never `contextHrefFrom` — "where
  you last were" in the context you are standing in is where you are). One name,
  one place, and the press does something.

  The owner's description is the specification, and it is quoted in `NavBand`
  because the first implementation got it backwards: *"the button for that
  workspace should essentially move to the breadcrumb… that workspace button
  removes from the workspace column, but is put in the breadcrumbs column. So
  I'm still able to get to the root."*

  Three consequences. The strip has no lit pill and nothing on it is
  `aria-selected`, because every pill goes somewhere you are not. `stripEntries`
  draws the row at one entry rather than two, since none of them is a label any
  more — and somebody with one workspace and no others now gets **no** strip and
  their name at the head of the path, which is the better trade. And the
  long-press menu moved with the pill: context Settings is reached on a phone
  through that menu and nowhere else, so leaving it behind would have taken
  `/console/[slug]/settings` off the phone entirely.
- **Row two is one scroller.** The button and the segments are one line — *this
  context, then this folder* — and two scrollers would let the button sit still
  while its own path slid out from under it. So `NavBand` owns the `ScrollView`
  and `Breadcrumb.pathOnly` returns bare segments into it. It carries the
  strip's falloff for the strip's reason, and that was found in a browser rather
  than by a test: a deep path overflows this row far more often than the
  contexts overflow the one above, so the row that needed the fade most was the
  one that shipped without it.
- **The strip is built by the layout and passed down, not rebuilt at the leaf.**
  It needs the context list, the recently-visited log and the router, and it has
  to be drawn two levels below. A second one assembled where it is drawn is two
  copies of a control, which is how one of them ends up with a handler the other
  does not have — the failure `NoteEditor.pathBar` already exists to prevent one
  layer down. It travels as a `ReactNode` through a context (`NavBandProvider`).
- **The band pays the horizontal gutter for both of its rows, and the caller
  decides the number.** The strip took the top bar's `space.x3` while it lived
  there and had no padding of its own; dropped into a scroller it sat flush
  against the glass, a row of pills a quarter-inch to the left of the note under
  it. Which number is right depends on what the band is above and only the
  caller knows — `layout.readingMargin` over a document, nothing at all inside a
  pane whose content container already pays one — so `Breadcrumb.barPath` gives
  its own up and takes the band's.
- **The frame's top row is two slots now, not three.** The account mark stays
  pinned at the leading edge because it is the product's only sign-out and a
  control you have to scroll to find is one somebody concludes is missing; the
  trailing capsule is untouched, because the scope and Share act on what is on
  screen and were never navigation. `appFrameRender.test.ts` asserts the pair
  and their order; `consoleChrome.test.ts` asserts that the strip is on the
  screen and inside the band rather than in the bar.

What did **not** change is the landmark: the strip is still the phone's single
`role="navigation"`, labelled `Contexts`, and the bottom row is still a toolbar.
Moving a landmark down the tree does not remove it, and
`consoleChrome.test.ts` still counts exactly one on a mounted phone console.

### A phone has no left panel, so the one thing its footer said had to move

The rail sheet, the file-tree drawer, both toggles and their scrim are gone at
`compact`; navigation is a context strip (in the scroller, above the path — see
the section above) and a seven-key bottom row, neither of which has to be
summoned. `features/app/frame.ts` carries the
whole of that decision and amends its own paragraphs in place.

What that removal cost is one line, and it is worth naming because deleting it
with the panel would have been silent. The tree's footer read
`R2 · workspace · 62% indexed · 12 notes, 8 folders` — the storage binding, how much
of the context is in the hosted index, and how much of the tree has actually
been read — and its own comment recorded *why it was on a phone at all*: at
`compact` the frame draws a bottom toolbar and **no status strip**, so without
it the only way to learn how far a backfill had got was to open settings, which
is precisely the state that made a stuck backfill and a working one look
identical for hours. Two of those three facts had no other route on that
density at all.

**It is the foot of the context root page now**, composed by
`features/console/files/contextFoot.ts` and drawn by `FolderView`. Four things
about that are decisions rather than placement:

- **The root page and not every folder page.** The three facts are about the
  *context*, and the root is the one folder page that **is** the context —
  `FolderView` already took a `contextLabel` for exactly that. `loadedCounts`
  counts every listing that has been read rather than the open folder's, so
  under a subfolder's own rows the same numbers would be read as a count *of*
  that subfolder: accurate, misread, and worse than absent. A caption repeated
  under forty pages is chrome.
- **Compact only.** A pointer layout says all three already — the bucket and
  the tier are the top bar's chips, the percentage is the status strip's
  segment, the counts are the tree's own foot — and a second copy under the
  listing is the same facts twice on the density that never lost them.
- **One composer, and the words still come from `describeIndexProgress`.**
  That function is the owner-only gate as well as the phrasing: `notesIndexed`
  and `notesPending` are `undefined` for a member because the index counts
  private notes they cannot read, and a percentage is that total divided (see
  [search](../search.md), *The backfill percentage is derived*). Composing a
  figure at this call site instead is the natural shape of a second
  implementation and it hands a member exactly what the server withheld —
  measured, it reddens both member cases, the `off` case and two owner
  wordings.
- **Each of the three parts is omitted rather than filled in, and the three
  absences mean different things.** `undefined` storage is "the binding has not
  answered" and says nothing; `null` storage is "no bucket connected" and is a
  claim worth making; a `null` index figure is a member, an `off` context or an
  unanswered status and draws nothing at all — not a dash, not a `0%`. The
  counts are always drawn, because "Nothing read yet" is true of an unexpanded
  tree and an empty string is not.

**And the page it sits on had to become reachable.** With no tree, a phone
landing on `/console/@slug` with no `?note=` drew "Choose a note to read or edit
it. Right-click any row — or press and hold on a phone" — a sentence naming a
gesture with nothing on the screen to perform it on, and no route to a single
note in the context. `BrowsePane` draws the context's own root folder there
instead, at `compact` only, as a **render fallback and not a `select("")`**: a
selection written there would be a third writer of the relationship
`useNoteAddress` owns two directions of, and `noteAddress.ts` exists because
that relationship oscillates when more than one thing drives it. A pointer
layout keeps its empty state, where "choose a note" names a tree that is on the
screen.

**The navigation landmark moved with them too, and for a while it did not
arrive.** `AppFrame` declares `role="navigation"` on exactly two things, the
rail column and the rail sheet, and neither is rendered at `compact`. The
assertion that a phone had one was written about the sheet and was deleted with
it, so a phone-width browser window had **zero** `<nav>` landmarks: every pill
and every key kept a real `aria-label`, and a screen-reader user rotoring by
landmark — or anything that jumps to `<nav>` — could not find the navigation at
all. Labelling each control and being able to find the group of them are
different capabilities, and the second one was lost silently.

The **context strip** carries it: `role="navigation"`, labelled `Contexts`
rather than the rail's `Console`, which needs no disambiguation because the two
are never on screen together. The **bottom row deliberately does not** — it
stays `role="toolbar"`, named `Console actions`. Six of its seven keys are verbs
about the open note, and calling a row of verbs "navigation" because one
destination sits at the end of it behind a separator makes the landmark mean
less rather than more. `contextStrip.test.ts` holds the declaration and
`consoleChrome.test.ts` counts the landmarks on a mounted phone console —
exactly one, and not the toolbar — because a component that declares a role
correctly while the density renders none of it is the failure this replaces.

**Sign-out moved with the panels and had to grow.** It is the only sign-out
control in the product; it was at the foot of the rail, which a phone can no
longer reach, and it is now the pinned account slot at the leading end of the
top row — since the contexts left that row, the only thing in it at that end. The mark stays `layout.accountAvatar` (34) and the pressable around it
is `layout.minTouchTarget` — it had been padding by 4, so the target was 34 and
under the floor, and the row's width budget in `tokens.ts` and `AppFrame` was
written against the mark rather than the target. Both are corrected there.

What a simplification of any of this costs, and the tests that fail:
`indexProgressSurfaces.test.ts` carries the sabotage table for the figure
itself, `noteChrome.test.ts` follows each of the four things the tree's footer
carried to where it went, `storageUnknown.test.ts` holds the three-valued
binding on this new surface — a guard that measured **zero** failures until
those three cases were written for it — and `consoleChrome.test.ts` holds the
strip, the bottom row and sign-out's 44pt.

### A copy is one press, and it is confirmed outside the modal

Copy link on a share put nothing on the clipboard and said nothing about it,
on iOS. The cause is a rule about *when*: Safari grants the clipboard to a call
made inside the user activation a press starts, and the dialog awaited a round
trip — minting the share row — before writing. That spends the activation, the
write is refused, the caller correctly declines to claim a copy it did not make,
and the button silently stays "Copy link".

So **minting and copying are one call** (`FileBrowser.copyShareLink`), and
`copyDeferred` is what makes that possible: `ClipboardItem` accepts a *Promise*
for its data, so the write is issued inside the gesture and the round trip
settles inside it. Browsers without that form throw on construction and fall
back to awaiting and writing — which is safe, because they are the ones that do
not enforce the window. Splitting it back into "await a URL, then write it" is
the tidy-up that restores the bug, and it restores it **on one browser only**,
which is why the test asserts the *order* rather than the clipboard's contents:
both versions leave the same text on the same clipboard everywhere else.

**A copy is invisible, so it is confirmed where the confirmation outlives it.**
The dialog used to relabel its own button "Copied" and stay open, which puts the
only evidence inside a modal the person has just finished with and then throws
it away when they close it. A successful copy closes the dialog and raises the
pane's notice; a failed one keeps the dialog open and the notice carries the
URL, because the clipboard is the only part that did not work and the person
still wants the link. On native there is no clipboard at all, so that is the
whole feature there rather than an edge case.

The `execCommand` fallback also had to be fixed to work on the platform it
exists for: `readonly` plus `select()` is the recipe every snippet shows and the
one iOS ignores — it refuses to select a read-only field, so the copy takes
whatever was selected before, usually nothing.

### A write from outside the file browser has to say so

The console refreshes a folder whenever **it** writes into one — `save`,
`create`, `move`, `archive` each end with `refresh([parentPath(path)])`. Every
one of those is the browser changing the bucket and telling itself, which worked
for exactly as long as the browser was the only thing that wrote.

A meeting is the first write in this product that reaches the same bucket from
somewhere else. It went unannounced, and the symptom is the shape that makes
this a decision rather than a fix: **the phone that had already read the folder
was the one that did not show the note.** A client that had never opened
`0-inbox/meetings` fetched it on the way in and drew the meeting immediately;
the device that recorded it kept the listing it was holding. "After saving the
meeting it did not show up on the mobile app, but it showed up on the web app."
Nothing was lost — the note was in the customer's bucket the whole time — which
is precisely why nothing surfaced it.

`features/console/files/bucketWrites.ts` is the seam, and it is a bus rather
than a call for a reason in each direction. **The console must not know that
meetings exist**: it is a file browser over a bucket, and the second outside
writer must not need a second branch in it. **The meetings gateway must not hold
a console hook**: it runs from a screen the console does not own. Both import a
module that knows about neither.

Four things about it are decisions:

- **It carries the workspace and the path, and never the text.** This is a
  signal that a listing is stale, not a second channel for note bodies — a
  subscriber taking content from here would hold a copy the cache never saw, at
  a clearance nobody checked ([*A copy on the device is bounded by who read it*](#a-copy-on-the-device-is-bounded-by-who-read-it-when-and-whether-the-server-said-no)).
- **The reader checks the workspace.** One device is signed into several
  contexts and `useFileBrowser` is mounted for one of them; the same folder path
  is a different folder in a different bucket.
- **It refreshes the parent and every ancestor already held, not the parent
  alone.** A write into a folder that did not exist changes its *grandparent*
  too, and that is the ordinary case rather than the exotic one: the first
  meeting anybody records creates `0-inbox/meetings` under the `0-inbox` they
  are looking at, so a parent-only refresh fixed the second meeting and none of
  the first — the same symptom one level up. Held rather than all, because a
  refresh of a folder nothing has asked for is a request whose answer nothing
  draws; and the root is prepended by hand, because `ancestorsOf` starts at the
  first segment and never yields it.
- **It announces after the write resolves.** An announcement of a write that
  then failed makes every listener reload a folder to learn nothing, and raises
  the console's own "the file list did not reload" notice about an operation
  that never happened.
- **Nothing is buffered or replayed.** A console that mounts *after* the write
  reads the folder fresh on the way in; replaying would make it reload a folder
  it has just loaded.

The checks are `a meeting landing in a folder the console is holding reloads
that folder`, `a write to another context refreshes nothing here`,
`a meeting note announces the folder it landed in`, and `a write that failed
announces nothing` — the first two sabotage-tested against the effect and
against its workspace guard separately.

### A copy on the device is bounded by who read it, when, and whether the server said no

Three rules sit under the queue and the cache, and each of them was reachable
as a working exploit in the first version of that feature. They are separate
because they fail separately: fixing any one of them leaves the other two.

**A cached copy carries the clearance it was read at, in the key.** Every note
and listing on the device is a copy of an answer `scopeForRole` had already
filtered — an owner reads at `private`, everybody else is narrowed to `team`.
Membership is a row in the control plane that an owner changes from another
machine, and nothing on this device hears about it: `forgetContextCopies` fires
when a context *leaves* your list, and a demotion does not. So the clearance is
a segment of the key (`scopedKeyFor` in `features/offline/keys.ts`), not a field
beside the value — a demoted session builds a different key, misses, and takes a
round trip. A field would need a comparison at every read, and a comparison is
something a later call site can forget. `keyFor` is typed to `UnscopedKind`, so
filing a copy under no clearance at all is a compile error rather than a review
note.

`readableAt` is the direction and the direction is the security property:
`private` may read a `team` copy, `team` may never read a `private` one. Adding
`"private"` to the `team` answer is the one-line way to put the leak back;
losing the widening costs an owner a cache miss, which is the right way round.
Only `note` and `listing` are scoped. A draft and the queue are the person's own
typing, carry no clearance, and keying them by one would orphan unsent work on a
demotion — `waitingOnDevice` would still count edits the console could then
neither show nor drain.

**A refusal is never overruled by a copy.** The read paths fall back to the
device when a read fails, and the `catch` they sat on could not tell a captive
portal from a removed membership — so a revoked grant became a cache hit, with
an age stamp under it that made it read as considered. `isServerRefusal`
(`features/console/files/browser.ts`) splits the two on the same shape check
`toFileError` already uses: a `ConvexError` carrying `{ code, message }` is the
only thing this server produces deliberately, and anything else is transport and
may not deny somebody their own copy. **`OVERRIDABLE_STORAGE_CODES` is a list of
codes safe to override, never a list of codes that are denials** — an unknown
code is treated as a refusal, so a denial added next year is closed by default.
The inverted list reads the same and fails the opposite way.
`STORAGE_NOT_CONNECTED` and `STORAGE_UNUSABLE` are on it because they are raised
*before* `executeOperation`, after membership and role, so nothing was refused —
a person whose bucket is down is exactly who an offline copy is for.
`apps/convex/__tests__/storageCodePosition.test.ts` reads the allow-list out of
the console and pins that premise where it lives, because it is a fact about the
server asserted in another app.

**The sign-out clear is a barrier, not a moment.** `forgetEverything` had no
production caller at all for one release, and wiring it is only half the fix: a
`remove()` loop deletes the keys that exist while it runs, and every writer in
the offline layer is fire-and-forget over an async store fed by Convex actions
with no client-side timeout. The measured result was a private note body back in
`localStorage` *after* sign-out. So `endSession()` in `features/offline/epoch.ts`
is bumped **before** anything is removed, each mount captures the number once,
and every writer — and the drain — drops work from a session that has ended. It
re-arms by itself on the next mount, because a barrier that has to be lowered by
hand is one that stays raised the day somebody forgets. The clear never blocks
(being unable to end a session is worse than a cache that outlives one) and
never absorbs: it is bounded by a deadline, because a wedged bridge never
settles and a `catch` has nothing to catch, and it re-lists what it owns
afterwards rather than trusting its own removals. Leaving a context clears it
**on the server's answer, never on the request** — `leaveWorkspace` answers
`{ left: false }` for a row it did not find, and clearing on the press would
discard the copies of a context the person still has.

