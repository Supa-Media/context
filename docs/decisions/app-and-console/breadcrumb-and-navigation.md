# App and console — breadcrumb and navigation

### The breadcrumb is the whole path, and its head is a real way up

Two screenshots from a phone, and one report:

> when you click on a workspace it puts it inside the breadcrumb. But clicking
> on the workspace name in the breadcrumb should take you to the root. Right now
> it doesn't do anything. It persists where it last was, which is good when
> you're going from one workspace to a new workspace, but not good for a
> breadcrumb. It doesn't even show the rest of the items, what path you're in.
> The UX there is pretty broken; you're not able to really navigate.

Three defects, and each of them is a decision recorded above being right about
its own case and wrong one step later.

#### 1. The lit pill did nothing, because there was no "close the note"

`CurrentContextPill` presses to `browseHref(slug)` — `/console/@seyi`, no
`?note=` — which is exactly what "open its root" means. **The URL is a mirror**
(above) then re-addressed the open note within the same tick, because
`noteAddress.ts` read a console URL that had lost its note as *stale* rather
than as an instruction, on this reasoning:

> there is no "close the note" for it to be expressing — `select` takes a path
> and the file browser has no deselect — so treating it as one would leave the
> address bar disagreeing with the screen.

Correct about the mechanism, and the cost was the one control on the screen
labelled as the way up doing nothing at all. So the missing verb is the fix
rather than the excuse: `FileBrowser.deselect` is `select`'s inverse — flush
autosave, ask `guardLeaving`, clear the selection, empty the editor, drop
`opening` — and the address rule becomes symmetric. **A URL that changed is a
navigation**, honoured whichever way it went: to a note it is a link, to nothing
it is a close.

The asymmetry that is left is the one doing the work. A URL that did *not*
change is not a navigation, whatever it says — somebody tapping a note at
`/console/@seyi` produces a commit where `note` is `null` and the selection has
moved, and reading that as a close would shut every note one commit after it
opened (`noteAddress.test.ts`, "a URL that never had a note does not close what
the person just opened").

Two consequences that are not obvious and are each held by a test:

- **A refused close puts the note back in the address**, where a refused
  `select` does not. A refused `select` leaves `?note=` naming the note somebody
  was going to, and a reload opens it — where they were headed anyway. A refused
  close leaves the address at the root with a conflicted note still open and
  unanswered, and the phone writes that address to the device: the next launch
  would come back to the root with the conflict gone from the screen and the
  draft still in the outbox.
- **Closing settings has to name the note behind it.** `SettingsPane` is pushed
  over Browse and leaves it mounted, and the route dismissed it with
  `router.replace(browseHref(slug))` — harmless while a bare console URL meant
  nothing, an instruction to close somebody's note now. `settingsClose.test.ts`
  exists to stop that being tidied back into the one-liner it was.

The device record needs no new machinery: `useRememberPlace` is fed the *URL's*
note (see **A URL is a context and a note**), so a press that clears `?note=`
files the context at its root by construction, and the relaunch after it does
not reopen what was just closed.

**Amendment: the first fix did not hold, because `router.replace` to the same
screen is a remount, not a no-op.** Everything above is right, `deselect` is
still the missing verb, and it shipped with `onOpenRoot={() =>
router.replace(browseHref(current.slug))}` in `_layout.tsx`. On a native
build the pill still did nothing — reported again, this time filmed on an
iPhone rather than described from a screenshot.

`router.replace` dispatches a React Navigation `REPLACE` action, and
`@react-navigation/routers`' `StackRouter` answers every `REPLACE` by calling
`createRouteFromAction`, which mints a route key from `` `${name}-${nanoid()}` ``
**unconditionally** — there is no branch that reuses the current key because
the params did not change. A fresh key remounts whatever that key names, and
what it names here is `ContextBrowseRoute` — not `_layout`, not
`ConsoleDataProvider`, not the `FileBrowser` instance underneath it, all of
which are mounted a layer up and do not move when a child's key changes.
`useNoteAddress`'s `seen` ref lives on the side that remounts. So the press
that was supposed to close the note instead: cleared the URL's `?note=`
(correct), remounted the hook watching it (not requested by anything in the
fix), reset `seen` to `null`, and handed `nextAddressStep` a "fresh" instance
holding a leftover selection — which it read as a cold load whose URL simply
had not caught up yet, and answered `address`, writing the note straight back
before the closed screen was ever visible. The round trip landed exactly
where it started, silently, once per press.

Nothing about the first fix's *reasoning* was wrong: `deselect` is still
exactly the missing verb, and the symmetric rule — a URL that changed is a
navigation, honoured whichever way it went — is still the right rule for a
URL that actually needs to *go* somewhere. What was wrong is that the pill's
press never needed to be a navigation at all: there is no route to leave and
none to arrive at, only a selection to clear in the browser standing above the
route. So the call site changed to `onOpenRoot={() => { data.files.deselect();
}}` — no `router` call, no `REPLACE` action, no remount, no `seen` reset,
identical on web (where this was never visibly broken; see below) and native.
`useNoteAddress` sees the selection change under an unchanged URL and takes
the same "address" step a tapped-closed tab already takes, and the address
lands one commit later with nothing in between for a remount to corrupt.

Because the *reason* the shipped fix broke — a `seen` reset while the browser
survives — is a property of `nextAddressStep` and not only of this one call
site, `noteAddress.ts`'s `fresh` branch no longer trusts the assumption the
remount violated ("the selection is empty by construction"). It now closes a
leftover selection instead of re-addressing it, which is provably safe rather
than merely reasonable: `useFileBrowser` clears `selectedPath` in the same
commit it adopts a new `contextId`, so a *genuinely* fresh instance can never
reach that branch holding a non-null selection in the first place — the
combination is unreachable except through exactly the remount this amendment
describes. `noteAddress.test.ts`'s "a fresh instance holding a leftover
selection closes it rather than re-addressing it" pins the new answer, and
`breadcrumbRoot.test.ts`'s "closes the open note even if the route remounts
under the press" reproduces the composed bug directly — a route remounted in
the same commit the URL drops its note — as a standing guard against a future
call site making the same round trip for the same reason.

**This is not native-only, and the source says so rather than a screenshot
from the field.** `expo-router`'s `<Slot/>` (`views/Navigator.js`) renders the
focused route as `descriptors[state.routes[state.index].key].render()`, and
that `render` — `@react-navigation/core`'s `useDescriptors.js`, one
implementation, no `.native.js`/`.web.js` split — wraps every screen's element
in `key: route.key` before handing it back. `StackRouter`'s `REPLACE` handler
mints that key from `` `${name}-${nanoid()}` `` unconditionally, with no
branch that reuses the current key when the params it carries are otherwise
identical. None of this is platform code: it is the same `@react-navigation/
core` and `@react-navigation/routers` packages under both the native-stack
view and the web bundle, and React's own reconciliation-by-`key` does not
special-case a browser. A changed key is a new element on every renderer React
has. So the remount is not a maybe to be masked by timing — it is a guaranteed
consequence of calling `router.replace` on this route on **any** platform this
app ships to, and the symptom it produces (the still-open note, because
`nextAddressStep` writes it straight back) is not a race either, so there is
no window in which a faster or slower browser would come out differently.

What is genuinely unverified is only whether anybody happened to *notice*: no
test in this repository mounts the real `expo-router` navigator against a
real browser history, and the owner's report came from a native build. Given
the mechanism, the honest expectation is that a web session pressing the same
pill hit the identical silent round trip and nobody was looking — not that
the web platform was ever exempt from it. Treat that absence of a web report
as absence of evidence, and not as license to reintroduce a `router.replace`
here on the reasoning that nobody saw it fail in a browser.

#### 2. The path stopped one segment short of where you were

**A phone gets a path bar** (above) argues the leaf away: the note names itself
inside the document, so a trailing segment says the same words twice. The rule
is real — `ShareScreen` was fixed for exactly it — and it was applied to the
wrong element. Both of the names it defers to are **inside the scroller**: they
are gone the moment somebody reads past the first screen, and the band is what
stays. Worse, it made `index.md` — every context's front page, and the first
note anybody opens — render as a lit pill and nothing else, over an open editor.
That is the second screenshot.

So the leaf is drawn, on both densities, and it is a **position rather than a
control**: pressing it would re-select what is already open. It says what the
note *calls itself* (`noteHeading`, the same ladder the inline title climbs)
and, falling back to the filename, drops the `.md` — filing, not a name, and the
same trim `noteHeading` already made.

The count of segments is capped and no label is ever shortened, which is
`ContextStrip`'s rule kept and its scope corrected. Nothing truncates is right
about **names** — `3-resour…` and `3-resour…` are two folders that look
identical on the control whose job is telling them apart. It is not an answer
for **depth**, because the segment that scrolls off the trailing edge is the
leaf. Past `MAX_FOLDER_CRUMBS` the middle elides to `…`, keeping the root folder
— the PARA bucket, where you go to start again — and the immediate parent, where
you go to step back. Nothing becomes unreachable: both are pressable, and the
root folder's listing is how anybody reached the hidden ones in the first place.

**Two, not three, and the number came out of a browser rather than out of the
argument.** Three was written first and then measured at 390pt with Playwright:
`3-resources/books/reading-notes/2026/the-lean-startup.md` elided to three
folders still put the leaf 137pt past the edge, and to two put it 27pt past.
Which is the honest conclusion — **a count cap cannot guarantee a fit**, because
segment names belong to the customer and no count is a width. What it buys is a
row that is *bounded* instead of one that grows with the tree, and the segment
it drops is the middle of the path, which is the part a breadcrumb is least read
for.

**Superseded, 2026-09-10.** The cap this argues for is gone — `MAX_FOLDER_CRUMBS`,
the "first, gap, last" reshaping, `crumbs.ts`'s `{ kind: "gap" }` crumb — deleted
along with the character budget it grew into (§4, below), because the constraint
both existed to solve was *width*, and width stopped being a constraint the day
row two of `NavBand` became a horizontal `ScrollView`: the owner's own words,
once that scroller existed to make the question worth asking again, were "I feel
like we shouldn't even show `...` ellipses, we should just show the full path but
allow a horizontal scroll." Removing the cap makes strictly **more** of the path
reachable than "two, not three" ever kept — every segment is its own pressable
target now, not only the root and the immediate parent a cap kept live — so the
reachability this section argues for is satisfied rather than reversed. What
expired is only the reason a cap was thought necessary at all; the measurements
below are kept as the record of why it once was one. See `crumbs.ts` and
`features/console/files/Breadcrumb.tsx`.

The row stays anchored at its **leading** edge when it does overflow, and that
is a choice about what may go off screen. The pill is a control — the way up,
and the thing this whole change is about — while the leaf is a statement the
document under it also makes. A control you cannot reach is worse than a fact
you have to scroll to, and `NavBand`'s trailing fade is what says there is
more.

`crumbs.ts` is one pure function and both renderers map over it, the pointer
layout passing `maxFolders: null` because it has the width for the whole path
and a chip beside it. That is the answer to "unify rather than duplicate": the
last time the two surfaces each decided for themselves what a segment was, one
of them dropped the leaf, then the context, and shipped.

#### 3. A switch must not draw the old context's path under the new one's pill

**A URL is a context and a note** (above) fixed the address and the device
record across a switch. The band has the same lag from the other end and needed
saying: everything else in `BrowsePane` is drawn from the file browser's own
state and stays internally consistent while the browser catches up — the
breadcrumb does not, because the pill at its head comes from the *console's*
selection and moves with the URL. Uncorrected it reads
`@supa / 3-resources / a-note-in-seyi`: one context's pill over another's path,
a sentence that has never been true, and exactly the "it persists where it last
was" in the report. `BrowsePane` draws the path only while
`files.contextId === data.selectedContextId`; until then the pill stands alone,
which is honest and is where the switch is going. Restoring the other context's
place is unchanged and is still the good half.

#### 4. A count cannot guarantee a fit, so a width budget does

**Superseded, 2026-09-10 — everything in this section is deleted.** `budget`,
`phoneRowBudget`, `CHAR_WIDTH_PX`, `SEPARATOR_CHARS`, the leaf's `fullLabel`,
`SLACK_PX` — all of it, along with the cap it topped up (§ above). The scroller
this section spent its whole argument working around answers "does the leaf
fit" for free, correctly, at every width and every font size, which a
pixel-width estimate could only ever approximate from one browser's rendering
of one font stack. Kept below as the record of why a budget seemed necessary at
the time and what it cost to get right; the sabotage table at the end of this
section is no longer a live guard, since the code and the tests it names do not
exist any more.

**Two, not three** (above) said the honest thing about `MAX_FOLDER_CRUMBS`: a
cap bounds the row, it does not fit it, because segment names are the
customer's and no count is a width. That honesty shipped as two screenshots —
`1-note-two-folders-deep.png` had the leaf's last two letters under the
trailing fade, and `5-deep-path-elided.png` cut "the-lean-startup" to
"the-lean-sta…" — on the one segment the whole row exists to state. "Scroll to
see the rest" is a real answer for a folder somebody mostly reads by shape; it
is not one for the note's own name.

So a caller that needs the fit guaranteed — today, only the phone's `pathOnly`
row — passes `crumbs.ts` a character `budget`, converted from the screen's own
width by `Breadcrumb`'s `phoneRowBudget`, and the leaf becomes the thing that
is protected rather than the thing that goes missing. Folders give way first,
and **from the front, one ancestor at a time**, rather than in one jump to a
bare `…`: the immediate parent is the folder worth keeping pressable
longest — it is where "step back" actually goes, which the pill in front of
this row does not reach — so it survives until the width genuinely has no room
even for it alone. Only when a single `…` standing for the whole path still
does not leave the leaf room is the leaf's own label shortened, and it is
shortened in the **middle** (`the-lean…tup`) rather than at an edge, so it
keeps both the word somebody typed and the word they would search for.

Every pixel constant this needs — the band's margin, the trailing fade, the
pill's own footprint, a flat safety margin — is named for the real style it
estimates rather than folded into one guess, and every one of them is biased to
**overestimate** the room the pill and the chrome take: a budget that thinks
the row has less space than it really does costs a folder that could have
stayed live, never a leaf that spills past the edge it was computed for. That
bias is not a preference, it was found the hard way — the first cut of this fix
priced a separator at one glyph and left the row 18pt over anyway, because
`NavBand`'s flex row puts a 6pt gap on *both* sides of every separator and
nothing had charged for it. `SEPARATOR_CHARS` (`crumbs.ts`) and `SLACK_PX`
(`Breadcrumb.tsx`) are that correction, kept as named constants rather than
folded back into `CHAR_WIDTH_PX` so the next person tuning this can tell which
piece moved.

#### The tests that fail if any of it is reversed

Sabotage record — each applied as a local edit, run, reverted. Counts are
failing tests.

    the URL that lost its note re-addressed (the shipped rule)          5
    `close` whenever the URL has no note (every note shuts on open)     1
    `deselect`'s refusal ignored by `useNoteAddress`                    2
    `deselect` without the unsaved-changes guard                        1
    the leaf dropped again (ancestors only)                            16
    no elision, the row just gets longer                                3
    `BrowsePane` drawing the previous context's path                    1
    settings closing to the bare console href                           1

`breadcrumbPath.test.ts` owns the pure path model, `breadcrumbRoot.test.ts` the
pill press end to end (it closes the note, the device stops remembering it, a
refused close comes back, and pressing *another* context still restores where
you were there), `noteChrome.test.ts` the rendered band, `linkedNote.test.ts`
the close against the real `useFileBrowser`, and `settingsClose.test.ts` the
one href a tidy-up would undo. `breadcrumbPath.test.ts`'s own "protecting the
leaf with a character budget" block carries the sabotages for §4 above — the
budget ignored past the cap, the leaf-truncation branch skipped, a leaf cut
from an edge instead of the middle — each a local edit to the width-budget
fallback, run and reverted, with the count in the test's own comment rather
than repeated here: the model they are against moves with `CHAR_WIDTH_PX` and
`SEPARATOR_CHARS`, and a number copied out here would drift from the one
somebody can actually reproduce.

**What is not covered here**: the numbers came from Chromium at 390x844 driving
the real components against the landing page's demo data, not from a device.
`phoneRowBudget`'s constants are estimates of real styles, checked against one
browser's rendering of one font stack — a different platform's font metrics
could still put the leaf a few points off from where this aims, which is why
every estimate in it is biased to assume *less* room than the real row has
rather than more. Whether that bias is generous enough on a 320pt phone, and
whether the trailing fade still reads as "there is more" once it is only ever
covering a folder and never the leaf, are questions for a phone in a hand — a
number to revisit, not an invariant. The screenshots that settled the original
count, and the ones that settled this fix, are attached to the pull requests
rather than committed: they are evidence for a decision, not a fixture anything
reads.

### A link key on the accessory bar, reversing the decision that dropped it

`NoteAccessory.tsx`'s own header used to argue, at length, against a wikilink
key: "it is Obsidian's wikilink key, and the `[ ]` beside it already covers the
one bracket pair that means something here." That was correct when it was
written and it is the sentence this section reverses — **A2** in the
editor-polish sweep, and the sweep is explicit that reversing a documented
decision needs the argument made again in the file rather than a quiet edit,
which is what this is.

**What changed underneath it, and why the same argument no longer holds.**
Three things were true when the key was dropped and none of them is true now:

- **A bare `[[name]]` did nothing.** `noteLinks.ts` drew a wikilink only once
  it resolved, and nothing resolved a bare name at all, so a key that inserted
  `[[]]` would have opened onto silence — the same failure mode F3 in the sweep
  names for typing one by hand. **L1** (the note-path index, `[[`-completion
  reusing the search index's own docmap) closed that: typing `[[` now offers
  every note the index knows about, on every density, which on a phone is
  close to every note in the bucket rather than the folder in front of you.
- **Links had no place in the phone's chrome at all.** *The phone gets a path
  bar* (above) is the section that put a breadcrumb back on a phone, and *A
  touch screen is told nothing about the gesture* (**L3**) is the section that
  gave a touch-followable link its own always-visible underline. Before both,
  a link on a phone was a bracket pair with no visual distinction and no way
  up if you followed one by accident. A `[[` key that opened onto that surface
  would have been a control pointed at a feature with nowhere to land.
- **The bracket-pair argument assumed one bracket key had to do both jobs.**
  `brackets` still draws the task checkbox — that has not changed and is not
  what this reverses — but "the one bracket pair that means something here"
  was true only because `[[` meant nothing yet. It is not an argument that a
  *second* key cannot exist; it was an argument that a second key had nothing
  to be *for*.

**What the reversal is, concretely.** A `link` key, inserting `[[]]` with the
caret placed between the brackets and the completion list opened immediately
— the same behaviour `linkComplete.ts` already gives a person who types `[[`
by hand, reached without typing two characters on a soft keyboard that makes
`[` two taps deep on most layouts. Placed beside `bullet` and `task`, the two
other keys `A1` established as "the thing a person writing notes in a hurry
actually reaches for" — a link to another note is exactly that category, not
adjacent to it.

**What this does not reverse.** The *reasons* Obsidian's own `tag` and
`attach` keys stay off the bar are untouched: this product still has no tag
model and no attachment upload from the console, and a key for either would
still be present and do nothing. This section is narrowly about the one key
whose absence was a fact about link resolution rather than a fact about the
product, and that fact changed.

The test that fails if this is reversed: `noteAccessory.test.ts`'s check that
the `link` key exists, inserts `[[]]` with the caret between the brackets, and
opens the completion — dropping any one of those three fails it and only it.

