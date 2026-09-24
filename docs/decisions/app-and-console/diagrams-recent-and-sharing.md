# App and console — diagrams, recent, and sharing

### A diagram lives in the note, and the browser is the only thing that makes it safe

A fenced block tagged `html-preview` is drawn as the thing it describes, inside
an iframe whose `sandbox` attribute is empty. **The fence tag is the entire
convention** — no new file format, no frontmatter switch, no per-note setting,
nothing in `privacy.md`. `cat`, `git diff`, GitHub and Obsidian all still show a
labelled code block, which is non-negotiable #3 ("plain files stay canonical")
applied to something richer than a paragraph: the diagram is *in* the file,
portable and diffable, and the console merely draws it. The opposite of a
proprietary canvas format.

**The security model is one attribute, and it is not ours.** Anyone can email
`<name>@context.lc` — that is the ingestion design, not a gap in it — so a note
the console renders may have been written by a stranger, and the console holds a
live authenticated Convex connection. The threat was never HTML or CSS; it is
script execution inside that session. A bare `sandbox` denies everything the
frame could do, script execution included. `allow-scripts` is never added (it
runs the note's JavaScript, in an opaque origin that still reaches `fetch` and
`postMessage` to the parent); `allow-same-origin` is never added; the two
together are worse than either, because a frame that is both can reach
`parent.document` and take its own `sandbox` off.

**No sanitizer, deliberately.** Filtering tags and attributes ourselves is a
list to maintain against everyone who has ever got past one, and it buys nothing
the browser is not already enforcing for free, with no bypass surface of our
making. A second mechanism nobody tests is not defence in depth. `previewDocument`
therefore puts the fence's markup into the frame's document **verbatim**, and
`htmlPreviewFrame.test.ts` asserts that it does, so a well-meaning filter cannot
be added later without deleting a test that says why it must not be.

**The CSP is on the frame for a different reason than script.**
`default-src 'none'; style-src 'unsafe-inline'; img-src data:` is there because
`background:url(https://…)` needs no JavaScript at all: a fetch out of a note
somebody emailed you is a read receipt telling the sender the moment you opened
it, and which note. That is a real privacy leak with no script anywhere in it.
There is no `font-src`, because a webfont is a fetch like any other. Blocking
inline script is a side effect of `default-src 'none'`, not its purpose.

Two things the earlier draft of this design asked for are **deliberately not
built**, and this is the reversal rather than an omission: a **separate origin**
for the frame, and **owner-only rendering** (a note that arrived by ingestion
never drawing). Both were priced against a frame that runs script. A frame that
cannot run script has nothing to do with the console's origin — there is no code
in it to be same-origin *with* — and "only render what the owner wrote" would
have meant a provenance flag on every note, a rule in `privacy.md` that
non-negotiable #5 does not have room for, and a diagram that silently refuses to
draw with no way for the reader to tell why. Both come back the day scripts are
allowed, which is a different project.

**The reveal rule applies, and it needed `pointer-events: none` to.**
`livePreview.ts`'s central argument is that you cannot edit syntax you cannot
see, so a drawn diagram becomes its own fence again the instant the caret enters
it, exactly as `## Heading` does. The frame is a separate document and swallows
its own clicks, so without `pointer-events: none` on it there would be no
pointer route back to the source at all — you could look at the diagram and
never reach the markup that draws it, which is the "block editor with extra
steps" failure that file exists to avoid. The preview has nothing to interact
with anyway: no scripts, and a link in a bare-sandbox frame cannot navigate.

**The frame's height is a number, and that is an honest gap.** Sizing an iframe
to its content means script inside it reporting a height out, and script inside
it is the one thing this never allows; the frame is cross-origin by
construction, so the host cannot measure it either. So the box errs tall —
`620px`, capped at `80vh` — because a diagram drawn short leaves empty space and
a diagram drawn tall loses its bottom third, and only the second is a failure a
reader notices. `overflow: hidden` on the wrapper is not tidying: markup from a
stranger that escapes its box draws over the breadcrumb, the save state, a
privacy control.

**What the sabotage run actually showed**, recorded because it is not what was
expected. Each guard was broken in turn against a real engine:
`sandbox="allow-scripts"` with the CSP intact left "a script does not run"
**green** — the CSP refused the inline script on its own; the CSP opened with
`script-src 'unsafe-inline'` and `sandbox` left bare was **also green** — the
sandbox refused it on its own, which is the claim this feature rests on and is
now measured rather than assumed; **both broken together went red**, so that
case is not vacuous. The reading is that each guard has a case that fails when
*it* is removed — the attribute is asserted directly in
`htmlPreviewFrame.test.ts` and in `e2e/webkit/htmlPreview.spec.ts`, the CSP
directly beside it — rather than one case that stays green as long as either
survives.

What a simplification of any of this costs: adding `allow-scripts` puts a
stranger's JavaScript in a session holding a live Convex connection, and
`htmlPreviewFrame.test.ts`'s "carries a bare sandbox" plus the WebKit suite's
"the frame's sandbox is bare in the shipped page" both go red on it; dropping
the CSP restores the read receipt and takes "forbids every fetch a stylesheet
could make" with it; rendering every `html` fence rather than only the tagged
one makes every note that *quotes* markup start drawing it, and "a fence tagged
`html` is not a preview" fails; dropping the reveal check makes the fence
uneditable and "the caret entering the block gives the raw fence back" fails;
dropping `overflow: hidden` or `pointer-events: none` fails "the preview stays
inside the note's own column" and "tapping the diagram gives the raw fence back"
respectively — both measured in a browser, because **two layout defects shipped
past a fully green jsdom suite in the Premium work** and this is the same class.

**jsdom cannot test the part that matters, and saying so is the point.** jsdom
does not enforce iframe sandboxing at all and does not load `srcdoc`, so a jsdom
test asserting "the note's `<script>` did not run" would pass with
`allow-scripts` set. That is the exact false green
[`testing.md`](../testing.md) exists to name. The execution case lives in
`apps/mobile/e2e/webkit/htmlPreview.spec.ts` against a real engine; the jsdom
suite asserts only what it can actually see, which is the markup that was built.

### A phone gets Recent, because it could never get a second tab

The console's bottom toolbar carried a **tab count** — Obsidian's, Safari's and
Chrome's number in a rounded square — and a press raised an **Open notes**
sheet. Both were built carefully. Both were unreachable, and the owner's report
is the whole of the evidence: *"It's like there's only ever one open note. I've
tried so many times to get more open notes, and there's just not a way to do
it… how do you even close a note on mobile here?"*

He was right on both counts, and neither was a polish problem.

**Nothing on a phone could open a second tab.** The only verb that produces one
is `openInNewTab`, and it was gated twice over: `menu.ts` offered it to
`platform === "web"` only, and its sole host — the Explorer's row menu — is not
drawn at compact at all, where `frame.ts` answers `explorer: "hidden"`. Every
phone open therefore arrived through `useTabs` as a `preview`, and `tabs.ts`'s
`open()` makes a new preview *replace* the preview slot. One in, one out. The
count could only ever read `1`, which falsifies the control's own stated
affordance — "the number is the affordance, it is the only thing on the toolbar
that changes as you work". The single path to a second row was an accident:
`edited` pins a tab, so "Open notes" on a phone meant *notes you happened to
type into this session*.

**And the comment defending the gate had the causation backwards.** It read:
"touch has a tab switcher rather than a pointer with a middle button, so the
second item is web-and-file only." A switcher *displays* a set of tabs; it does
not produce one. The line withholding the only verb that produces one cited, as
its justification, the surface it was thereby leaving empty.

**Closing did nothing, and that was structural rather than a missing call.**
`without` leaves `activePath` null when the last tab goes, and `useTabs`' effect
only follows a non-null one — so the × emptied the strip and left the note in
the editor. The chrome updated and the thing it claimed to close was still on
screen; `‹` then brought it back, because history is a separate stack. This is
not a forgotten line. On a phone the note **is** the page, so closing it is a
navigation, and `tabs.ts` is deliberately built knowing nothing about
navigation. Two models of "which notes am I working with" on a 390pt screen, one
of which owned display without owning navigation.

**So the phone keeps the model it already had, and that model gets a list.**
`history.ts` was already there, already pure, already what `‹` and `›` read.
`recentPaths` is the same array walked backwards — deduplicated, capped at
`MAX_RECENT`, folders included, because history records the *selection* and
"back to the folder I was in" is a destination a phone reaches constantly.
`RecentSheet` draws it, marks where you are, and has no × on any row, because
there is nothing to close.

The decisive property is not parity with Obsidian: **a tab list on a phone is
empty exactly when you need it**, since you have to have curated it first, and a
recents list is never empty because using the app fills it.

Two placements follow from rules already written here rather than from taste.
The key is **dimmed in place, never absent** — `‹` and `›` live by that rule two
positions up, and the tab count's own defence for being conditional ("it is the
last item on the bar") was false: Save, a rule and the meeting key all sat after
it, so every one of them slid sideways the first time a note opened. And `‹`
**held** opens the same sheet, which is where every browser on every platform
keeps its history list; the hold is in the accessible name, because a gesture a
screen reader is never told about is one only sighted people have.

**What went with it.** `TabSwitcher.tsx`, `TabCountButton`, `tabCountLabel`, and
`BottomBarAction`'s `count` and `badge` — the number-in-a-square and the
corner badge both existed for that one key and had no other caller. `marker`
stays: Save still has something momentary to say. The unsaved dot is not
reproduced on Recent, and that is deliberate — the console autosaves at 2s idle
and a 15s ceiling, so "unsaved" resolves itself while you read it; what does not
resolve is `needsDecision` (a conflict, a failed save), which speaks in the
notice line. Desktop tabs are untouched, and `menu.ts`'s gate now says what it
always meant: a phone has no tab surface, so it is offered no tab verb.

**One latent bug fell out of the close fix.** `useTabs` opened a tab for any
non-null `editor.path`, and `""` — the bucket root, a folder — is not null. In
production `emptyEditor` uses `null` and nothing writes `""`, so the phantom
nameless row was invisible: the prune deleted it a commit later. With the
last-tab rule in place that flicker becomes a **deselect nobody asked for**, so
the `opened` effect now refuses `""` at the source.

What a simplification of any of this costs, and the test that fails:

- Deriving Recent from a second, non-truncating log beside `entries` buys back
  the rows a branch drops and re-creates the two-models problem this removed.
  The cost is stated in `recentPaths`' own comment and pinned by "a branch drops
  the forward tail here too, because it is one array".
- Asking `recentPaths(state).length > 0` instead of `hasSomewhereToGo` lights
  the key on the first note of every session, offering to take somebody where
  they already stand — "one entry, and it is where you already are, is nowhere
  to go" fails.
- Reverting the last-tab deselect returns the control that does nothing:
  "closing the last one deselects; closing one of two does not" fails. Writing
  it as `length === 0` rather than as a transition throws away a cold load's
  `?note=` — three tests fail, "a cold load with a note open does not deselect
  it" first.
- Dropping the `""` guard brings the phantom root tab back, and with it a
  deselect on landing: "the bucket root is not a note, so it opens no tab to
  close" fails.
- Dropping `hint` from the held gesture's accessible name, or the 400ms
  `delayLongPress`, fails "the hold is in the accessible name, not only in the
  handler" and "holding fires the second verb and not the first".

**The sabotage run.** Nine invariants broken one at a time against the real
suite; every one went red, and each in the test that names it — the two
`recentPaths` rules, `hasSomewhereToGo`, the last-tab deselect in both its
wrong shapes, the `""` guard, both halves of the hold, and the sheet's marking
of the current row. The one worth recording is #5: writing the deselect as
`if (!has)` rather than as a transition failed **four** tests rather than one,
which is the shape of a guard whose absence is load-bearing in more than the
case it was written for.

### The share sheet is one control, and the padlock beside it is gone

The owner, looking at the sheet on a phone: *"the lock and the share icon can
be collapsed, they're essentially the same thing… it's confusing how to make
groups, it's confusing how to revoke access… when I type names there's not even
an autocomplete."* Four complaints, one root cause, and one of them turned out
to be a safety bug rather than an annoyance.

**They were not merely similar — they overlapped on the dangerous state.** The
padlock cycled `private → team → anyone-with-a-link`, and that third position
minted exactly the share row (`audience: "anyone"`) the sheet's own "Create
link" button minted. One object, two mints, and nothing on screen relating
them. Because most notes are `team` already by folder inheritance, an ordinary
note sat **one tap on an unlabelled 20pt icon** away from a link needing no
account, with a glyph changing to a globe as the only feedback.

`scope.ts` had argued that widening should be one deliberate step at a time and
that `private → anyone` in a single press is "the accident worth making
impossible". That is right about the rule and wrong about where the risk sits:
`team → anyone` was also a single press, from the state nearly everything is
in. The fix is not a fourth position or a longer cycle — it is that a decision
this size does not belong on an unlabelled icon at all.

So: one icon in the bar, and audience becomes named positions inside the sheet,
with the public step confirmed in words. **`scope.ts` is untouched** —
`scopeOf`, `nextScope` and `stepsTo` remain the pure model, and `setScope`
remains the single point every surface goes through, group guard included.
Only the control driving it changed.

**A simplification of this would put the padlock back** for the keystroke it
saves. What it would cost is the property the confirmation exists for: that
nothing publishes a note without a sentence saying what publishing means. The
test that fails is *going public asks first, and mints nothing until it is
answered* in `noteChrome.test.ts`, which asserts on the absence of a `setScope`
call, not on what the screen then shows.

#### Revoking one person's access has two routes, and they differ by a context

The sheet listed people with access as three strings — name, role, reason —
with no control on any of them. It diagnosed ("the folder it is in is shared
with the workspace") and left the cure three screens away in Settings.

The reason it had no Remove button is real and worth stating, because it is the
first thing a reasonable person would add: **`team` means every member, so one
person cannot be peeled off a team-visible note.** There is no per-note role and
no per-person exception — `privacy.md` is folder defaults plus exact-note
overrides, and an override is still one of the two tiers or a group. "Stop Kola
reading this" therefore has exactly two honest answers:

- **Narrow the note** to `private` with an exact-note rule. Per-note,
  reversible, and what most people mean.
- **Remove Kola from the context** with `removeMember`, closing every note and
  folder at once.

A single Remove beside one name would have to silently pick one. The small one
does not do what the button says; the big one closes an entire context from a
control labelled with one note's name. So the row carries **routes**, each
stating how far it reaches, ordered narrowest first, the wide one drawn
destructive. A group row gets the one route the console can honestly offer —
where the group is defined — because it cannot resolve group membership and
`access.ts` opens by refusing to guess.

**A simplification would collapse the routes into "Remove".** The test that
fails is *each route says how far it reaches* in `noteAccess.test.ts`.

#### A group is made where the group was needed

`GroupsPanel`'s own header says "Nobody should have to come here first" — and
it was the only door. Sharing one note with three people meant leaving the
note, opening Settings, typing a label, adding three members one at a time,
coming back, and typing the group's name. Eight steps for the thing groups
exist to make cheap, which is why nobody made one. The sheet offers it now; the
panel keeps what its header says it is for — renaming one, and dropping
somebody from every folder at once.

`GroupActions.createWith` exists because `createGroup` always returned the new
group's id and the console threw it away, so populating a group you had just
made meant re-reading a subscription that had not necessarily delivered.
Deliberately not atomic: a partial failure leaves a real group with some of the
people in it, which the panel shows and can finish — better than rolling back a
group a folder may already point at.

#### The autocomplete was shipped and unreachable

`ShareDialog` handed `recipientsFor` an exclusion set containing **every member
of the context**, so a matching colleague was filtered out of their own
suggestion list. On a team note that is everybody, and since the invite row
needs a *complete* address, typing a partial name produced an empty box. The
type-ahead had shipped in #425 and had never been visible for the common case.

Two separable mistakes. **What the set measured**: members of the *workspace*,
where what matters is who reaches *this note* — opposites on a private note, so
the field was blankest exactly where it had most to offer. It derives from
`accessRows` now, so one function decides who reaches a note and both the list
and the suggestions read it. **And hiding was the wrong answer anyway**: "no
rows" cannot distinguish "they already have it" from "no such person" from
"this field is broken", and those want different next moves. Somebody who
already reaches the note is shown, marked, sorted below the offers, and drawn
without a press behind it.

**A simplification would restore the exclusion** on the grounds that offering
somebody who already has access is offering to do nothing — true of the
*press*, false of the *row*. The test that fails is *a note everybody reaches
still answers the query* in `shareRecipients.test.ts`.

Shots of every state: `docs/design/share-sheet/`.

