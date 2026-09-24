# App and console — sidebar tree and testing

## The allowed-sender list stays beside the address it gates

Integrations stopped being a page of settings on 2026-09-18 (#710): three
Google panels became one list of connected things, and every control on it went
— the per-service destination fields, the eighteen schedule buttons, the
attachment policy, the target-folder picker. One stayed, and after the page
shipped there was a real question about whether it belonged somewhere else, a
Privacy or Security screen among them.

**It stays on Integrations, directly under the ingestion address**, and the
reasons are in this order:

- **The list has no meaning apart from the address.** "Who may write into this
  context by email" is unreadable on a page that does not show the address they
  would write to. Beside it, it needs no explanation at all — the address, then
  who may use it.
- **Splitting a control from the thing it controls is a known defect in this
  console, not a hypothetical.** The storage-update banner asked the same
  question of every new workspace (#718) because a fact was rendered somewhere
  that did not hold the fact it was about.
- **Ingestion is a property of a personal workspace** — a shared context has no
  capture address at all — and Integrations is already the page that knows
  that, refuses in its own words, and says why. A privacy screen would have to
  re-derive it.
- **It is the one control that is not a convenience.** Everything else removed
  was a preference with a good default; this one decides who can put notes into
  somebody's bucket, and the alternative to a list is an open drop-box on a
  semi-public address. A control of that weight is worth drawing where the
  reader is already looking at what it protects.

**Nothing about the security semantics rides on the placement**, and that is
what makes this reversible rather than load-bearing: the boundary is enforced
server-side in `functions/lib/ingestion.ts`, and the page draws what the policy
row already says. Moving the row later is a one-screen change.

The check is `the one control left on the page is the one that says who may
write into the bucket`, in `settingsOverlayRender.test.ts` — asserted on the
*page*, not on the panel, because a guard that mounts a component in isolation
proves the component and not the call site. Its neighbour, `...and the accounts
and the forwarding address are the other half of it`, exists for the same
reason: `sourcesPanel.test.ts` stays green with `SourcesPanel` deleted from
`SettingsPane` entirely, which is measured — removing that one line fails
exactly these two checks and none of the eleven that mount the panel directly.

## The tree is drawn from the press, and `privacy.md` is what it may not guess

Moving or renaming a folder used to repaint nothing until `moveEntry` had
answered *and* a `listFiles` had come back for each folder it touched. Two
serial round trips before one pixel changed, with the row still sitting where
it was — and the honest reading of a screen that does not react is that the
gesture did not take, so people did it again.

For a folder it was worse than slow. Listings are keyed by path, so every
listing beneath the moved folder was still filed at a path the bucket no longer
had, and `expanded` still named those paths too. The refresh reloaded the two
parents and nothing else, so the subtree you had open collapsed and had to be
re-expanded a folder at a time, each one its own request.

**The console now draws the operation on the press and reconciles afterwards.**
`files/optimistic.ts` is a pure function from the listings on screen to the
listings after the change, with the moved folder's subtree re-keyed and carried
across; `useFileBrowser` paints that, sends the mutation, and hands `run` the
**inverse operation** as a rollback.

The inverse and not a snapshot, and that is the part worth writing down: a
snapshot taken before the send would also roll back whatever landed while the
mutation was in flight — a background refresh, another folder's listing, a note
somebody saved — and a rollback that quietly reverts an unrelated fact is worse
than the stale row it was fixing. A move's inverse is the move with its ends
swapped, which is what `moveEntry` itself is, so there is exactly one thing to
get right.

**What it may not do is guess a visibility.** `privacy.md` is folder defaults
plus exact-note exceptions, keyed by *path*, so moving a folder can change what
everything under it inherits. Three restraints follow, and each is the
difference between a fast console and one that tells somebody a shared note is
private:

- **A folder nobody has read is left alone.** If the destination's listing has
  never been fetched, the moved row is not put anywhere. A listing invented for
  it would draw a folder that appears to hold exactly one note; absent is true,
  a listing of one is not.
- **A new folder inherits its parent's default**, exactly as the server gives a
  new key with no exception of its own — and `private` when the parent is
  unknown, so nothing drawn optimistically ever claims to be shared. The same
  rule, for the same reason, as `offline/overlay.ts`'s `fileEntry`.
- **Visibility is never recomputed locally.** The carried subtree keeps what the
  server last stated, which is stale until the refresh lands. That is not a new
  staleness — it is the same data the console displayed for the whole of the
  round trip this removes, at the right path and for less time. What makes it
  correct rather than merely shorter is `cascadeFrom`: a folder move reloads its
  whole re-keyed subtree, and `refresh` commits each folder as its page arrives
  rather than batching every page behind the slowest, so the marks settle from
  the top down.

**A timeout is deliberately not rolled back.** "No answer yet" is not "it did
not happen" — the socket may still deliver, and `TIMED_OUT_MESSAGE` says exactly
that. Putting the row back would state the opposite. A refusal *is* rolled back,
including the early refusal a read-only console gets: that console keeps all
fourteen mutating methods (`useDemoFileBrowser` sets each to a no-op), so a call
that slips past `canEdit` reaches `run` rather than throwing, and before the
drawing existed it was silent.

The checks are `optimisticStructure.test.ts` for the arithmetic and
`optimisticFolderMove.test.ts` for the wiring. The second holds the mutation
open — the action does not resolve until the test lets it — and asserts on what
is on screen while it is in flight, because a version that awaited the operation
first would pass against the code this replaced.

## What the sidebar can do to a folder, the listing can do to it too

The tree and the folder page are one listing shown twice, which this document
has said since `FolderView` was written. They were not one set of *gestures*:

- **Drag was the tree's alone.** `dnd.ts` has driven it since it was written and
  the folder page had nothing, so a folder you could reorganise by dragging went
  inert the moment you opened it — and at compact density, where `frame.ts`
  draws no file tree at all, there was no drag anywhere in the product.
- **On native, a listing row had no menu at all.** Its rows went through
  `useRightClick`, whose native half is a documented no-op. That surface is the
  *only* browse surface a phone has, so rename, move, duplicate, visibility,
  archive and delete were unreachable there.

Both are fixed by pointing the listing at what the tree already uses rather than
by giving it its own: `useRowInteractions` for the gesture, `dnd.ts`'s own
verdict for what a drop means. A rule that exists in one place cannot drift from
itself, and a drop refused in the tree is now refused in the listing with the
same sentence — said out loud through `files.say`, because a row that springs
back in silence teaches nothing.

One change to the shared hook came out of it. It suppressed the browser's own
context menu whenever a handler existed, which is safe for a tree row (always
has something to offer) and wrong for a listing row (`menu.ts` returns an empty
list for a read-only console). `onMenu` may now report back, and the web half
suppresses only what actually opened — the rule `rightClick.web.ts` already
stated at length, now shared rather than restated. `void` goes on meaning "it
opened", so no tree call site changed.

**What the listing still offers less of is "Share…", and that is deliberate.** A
share sheet is about one note's access, and the members, groups and removal
routes it needs are assembled for the *selected* note — a row you right-clicked
in a listing is not that. An item that cannot show who currently has access is
worse than no item in a product where `team` means named people.

The checks are `folderViewDrag.test.ts` (the pointer half, asserted on real DOM
events) and `folderRowNativeMenu.test.ts` (the half no DOM assertion reaches:
that every row goes through the shared hook, carrying its own menu and its own
drag verdicts).

### The sort control was a third instance, and it had nothing to point at

Drag and the row menu were fixed by aiming the listing at modules the tree
already used. The sort direction was not that shape: it lived in `Explorer`'s
own `useState`, so pressing "Sort Z to A" reordered the sidebar and left the
very same folder, drawn as a page beside it, still A to Z. `FolderView.tsx`
opens by calling itself "the tree, in the other place", and the one screen where
a person would check that claim was where it was false.

So the state got a home: `files/listingOrder.ts`, on `readMode.ts`'s shape and
for its reasons — `Explorer` and `BrowsePane` are siblings with `ConsoleShell`
between them, neither may import the other, and both may import a module that
knows about neither. What it costs is written in its header and is the same
bill `readMode` pays: not persisted, not in the URL, process-wide rather than
per context. A reload comes back A to Z. None of that is load-bearing, because
nothing here reaches storage — `orderedEntries` reverses a *presentation* of the
server's one order rather than inventing a second one.

`listingOrderShared.test.ts` asserts on the **drawn order of the rows**, not on
the store's value: a store that flips a boolean nobody renders from is the
version of this that passes a test and changes nothing on screen.

### The evidence is the drawn tree, because a hook's state is not a screen

`optimisticFolderMove.test.ts` holds the mutation open and asserts on
`browser.listings`, which proves the data moved and is one step short of the
complaint. The complaint was about a screen that did not react, and a hook whose
state changes while the tree still draws the old rows is indistinguishable, to
the person waiting, from no fix at all — which is the failure mode an optimistic
update is most likely to have, since it satisfies every state assertion on the
way to it.

`optimisticRepaint.test.ts` is the one that closes that: the real `FileTree`,
fed by a real `useFileBrowser` through the real `buildTreeRows`, in a real
reconciler, with the rows read **out of the DOM** while `moveEntry` is still
unresolved. Nothing in it inspects the hook. It also holds the part the tests
above cannot see at all — that an *open subtree* is still drawn, under the new
name, at that same moment.

### The corner makes five things, and one of them needs a key (2026-09-19)

The `+` replaced the microphone in the console's corner
([meetings](../meetings.md), *A meeting opens in the panel, and the corner is a
`+`*). What it offers is decided here, because it is a console question rather
than a capture one.

**Five items in three groups.** A meeting, then a note, a drawing and a folder,
then a chat. The middle group is a group because those three share a
*destination* — the folder you have selected, by `targetFolder`'s rule. A meeting
sits above them because it starts a recording rather than a file; a conversation
sits below because it makes nothing at all. The separators are that grouping and
not decoration.

They also shared a naming dialog when this was written, and two of them no longer
do: a note and a drawing are made on the press and take their name from what is
typed into them, and only the folder still asks. See *Nothing is named before it
is written* below.

**New chat is drawn only where the context has a model key.** The agent answers
through a key configured on the workspace, so without one the row opens a
composer whose first send errors — "a control that appears to work and does
nothing", which this console refuses everywhere else. `ConsoleData.modelConnected`
carries one bit; `listProviders` returns fingerprints and connection times and
never a key, and the projection keeps only whether the list is empty.

**It is gated on `=== true`, and the third value is the point.** `undefined` is
"the subscription has not answered", which is not "there is no key". Absent then
present is the honest direction for an offer; present then withdrawn is an offer
somebody may already have pressed. The Chat **tab** is deliberately not gated: it
is a place somebody goes on purpose and says in a sentence what it is for, where
a menu row is an offer made to somebody who was doing something else.

The checks are `pressing it offers everything a console starts`, `a context with
no model key is not offered a conversation` and `...and neither is one whose
answer has not landed yet`, in `consoleChrome.test.ts`.

### A control mounted by nobody passes every test of itself

`CreateButton` shipped with its own tests — what it draws, what its menu offers,
that it stands down at compact — and `console-create` appeared in exactly one
file in the repository: the component's own. Every one of those tests passes if
no screen ever renders it, which is **the same defect the microphone it replaced
actually had**: the corner was drawn by `NoteEditor`, so it existed on a note and
nowhere else, and the requirement it failed was "it should show up all the time,
even when on a folder page".

So the mount is asserted through the real layout — the corner on a context route
and on Map, the menu's contents, the absence of a second microphone beside it,
and the absence of the button at compact. `routeReachability.ts` makes the same
argument for routes; this is it for a control that is not a route.

Two things follow, and both were found by sabotaging the new guard rather than by
reading it. A jsdom test that reads `document.body` — which every test of a
portal-drawing control must — leaks its whole tree to the next test when an
assertion throws before its teardown line; and a test that sets a module-level
route and fails leaves the next one mounting a console somewhere else. Both are
torn down in `afterEach` now, and the symptom of the second was a sabotage run
reporting the phone's bottom bar missing, which was true of the route it had been
left on and nothing to do with the injected defect.

### A fixture that cannot show the thing under review is reporting on itself

`AppFrameVisualFixture` exists to answer "does the console look like the design",
and when the corner and the right panel changed it could show neither: the `+` is
mounted by the console layout that this fixture replaces, and the panel defaults
shut. It draws the `+` the way the layout does, and `?panel=meetings` opens the
panel on a running meeting — behind a parameter, because the artboards draw the
console with it closed and a fixture that changes the resting state is reviewing
a screen the design does not have.

Two defects were then found by looking at it in a browser, and neither was
visible to any test:

- **A menu anchored at the press point opened on top of the button.** `place()`
  puts a popover's top-left at the anchor and flips rather than clips, so a press
  inside a 56pt control against the bottom-right corner flipped the menu to *end*
  at the pointer, under the button. It anchors on the trigger's own top-right
  corner now, measured at press time — and opens *outside* that measurement,
  because `measureInWindow` never answers under jsdom and a button that does
  nothing there is worse than a menu placed at the margin.
- **An action row used the hero CTA beside a bare label.** `Button`'s own header
  prescribes `dialogPrimary` and `dialog` as a pair — "one shape, differing only
  in fill" — and ignoring it put a black slab with twice the padding next to a
  Discard with no shape at all.

The lesson is the one the fixture's header already carried and had not been
applied to a new control: a green suite is not evidence about a screen.

