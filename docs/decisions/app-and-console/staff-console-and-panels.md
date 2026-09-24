# App and console — staff console and panels

### The staff console is shaped for ten customers, and its figures count rows

`/admin` was eleven identical tiles and a credential form in one scroll. Every
tile was a count of events from `usageDaily`, every tile carried the same visual
weight, and the only comparison on the page was day-over-day. Read as a UI/UX
audit against the product it is actually for — a handful of accounts, more
contexts than people, a $5 subscription per context — six things were wrong, and
each one is a different mistake:

**A percentage of a single-digit number is not information.** One person opening
the app twice is `+100%`. `dayOverDay` was already careful to return `null` from
a zero baseline, which at this size is most days, so the honest half of the tile
was an em dash. The growth figures now print `+2 — 3 vs 1 before`: the change,
and both of the numbers it came from, because `+0` from "two and two" and `+0`
from "nothing and nothing" are entirely different weeks. The event counters keep
their percentage — tool calls and searches run to hundreds a day, which is a
denominator big enough to carry something.

**Eleven tiles of equal weight is no hierarchy at all.** "Site visits" read as
important as "active contexts". Four headline figures now sit above everything
else, and the rest of the page is not tiles: at n=11 the interesting fact is
nearly always *out of what*, which is a composition bar, or *who fell out*, which
is a funnel and a roster.

**None of the questions could be answered.** Contexts were one number with no
personal/shared split, no managed-versus-customer-owned split, no plan status, no
provider, no client. Every one of those is a decision someone takes weekly — what
we are paying Cloudflare for, who to email about a declined card, which AI client
to test against first.

**There was no revenue anywhere.** The product sells a subscription and the staff
console did not say how many were paying or what that was worth. MRR is derived
from `PREMIUM_PRICE_CENTS` rather than restating it, and counts `active` only:
`past_due` is a declined card, not income.

**At this size the answer is a person, not an aggregate.** Five accounts, two of
which never connected a bucket, is a morning's work to fix and is invisible on
any page that only aggregates. Hence the funnel and the roster — and the roster
is control-plane metadata only: an address, when they arrived, contexts owned,
whether storage verified, clients, plan. `functions/admin.ts` already forbids
per-note, per-path and per-query figures, and that card is the thing most likely
to tempt somebody to break it. No column there may name a note, a folder, or a
search.

**Rotating a Stripe key and reading a growth figure were the same scroll.** Four
tabs, because there are four errands.

#### Counting rows, and what it costs

The figures the audit asked for cannot come from `usageDaily`. A counter only
knows what happened since the day somebody added it, so a growth curve drawn from
one begins on the day it shipped — and personal-versus-shared, managed-versus-BYO
and plan status were never counted at all. `censusReport` counts **rows that
exist now**, bucketed by when they were created, which makes every figure
retroactive and exact.

Convex has no count API, so that is a table scan, and the trade is stated rather
than hidden. `CENSUS_CEILING` is 500 rows per table — low, because one census
spans ten tables including the two widest rows in the schema, and the failure
mode of guessing high is the one screen whose job is to report growth throwing
because it did. Past the ceiling every figure is a floor, `truncated` travels to
the client, and **the growth curves are withheld rather than drawn**: a
cumulative line missing an arbitrary slice of its rows is a different and wrong
shape, not a rough one. That is the same rule the note count already follows, and
it is the point at which counting should be replaced by maintained aggregates —
a decision somebody takes, not a constant somebody raises. Rows are read
newest-first so a page that fills drops the oldest, which is the half nobody is
asking about.

Three pieces of the arithmetic a "simplification" would get wrong, each with a
test:

- **The cumulative curve counts everything created on or before each day**, not
  only what landed inside the window. Restarting at the left edge re-founds the
  company thirty days ago.
- **Managed storage is told apart by the whole derived bucket name, never the
  `ctx-` prefix.** A customer's own bucket carrying our prefix and somebody
  else's id must not be counted as one we pay for — and the name is interpolated
  rather than taken from `managedBucketName`, which *throws*: correct when
  provisioning a bucket, wrong in a census, where one unusual row must not take
  the dashboard down.
- **The funnel is thresholds, not a staircase, and is deliberately not
  monotonic.** Somebody with a client connected to a context whose bucket never
  verified is precisely the customer to go and find; clamping each step to the one
  above it erases them from the one screen that could have shown them.

One more rule the page inherits from the chart work: a stacked bar lifts any
non-zero slice to `MIN_SEGMENT_PERCENT` and scales the large ones down to make
room. The widths are then not proportional, which is the trade — the count beside
every slice is the truth, and rendering one real paying customer out of four
hundred as zero pixels is the worse lie.

`usageReport` keeps the event counters and loses its two all-time totals from the
screen. One number arriving on one page from two different reads, with two
different ceilings, is how a dashboard starts disagreeing with itself.

### Both left panels fold, and the seam between them is the control

The console's two left panels on a pointer layout are the rail and the file
tree. The rail collapsed to its marks through ⌘B and nothing on the screen said
so; the tree did not fold at all — `explorerToggleFor` was a documented constant
`null`, above a comment reserving the decision for whoever took it. Both fold
now, and the decisions that a "simplification" would reverse are these.

**The control that folds a panel lives on the panel's own edge.** So the control
that unfolds it is where the panel was, and spatial memory does the work. A
toggle in the top bar puts the affordance for restoring a left column forty
points up and to the right of where that column used to be, which is how people
come to believe a feature was removed. The seams were already there as
hairlines, and are 7pt hit targets that reveal a chevron only under the pointer —
so the affordance costs nothing on screen at rest, which is what lets it be
permanent.

**A seam does one job.** The seam behind a resizable panel drags; the seam
behind a folded or fixed-width one is pressed. Putting a press target in the
middle of a drag handle takes the most natural place to grab a divider and makes
it do something else, and no amount of hover-revealing fixes that — the target
is there whether it is painted or not. The tree is therefore folded by dragging
its own edge past the floor, not by a button sitting on that edge.

**Dragging past the floor arms a close instead of refusing.**
`clampExplorerWidth` still renders nothing narrower than `explorerMinWidth`,
because that is where a kebab-case name under two indents stops being readable.
What changes is only what a *release* past it means. The clamp's own comment
gave the reason it refused — dragging a region to zero is how somebody hides it
and then wonders where it went — and that reason is answered by the seam left
standing, not by the refusal. `explorerCloseOvershoot` is the gap that keeps
overshooting the floor by a few pixels from folding the tree by accident.

**The drag handle is a sibling of the editor, and a drag on it is not up for
negotiation.** Both halves of that are hit-testing and event facts rather than
taste, and both were reported as one thing: "expanding the side panel drags
properly to the right, but not to the left — and when it works I have to move
really slowly".

The strip straddles the column's border, because people aim *at* an edge rather
than a few points inside it, so three of its seven points lie over the editor.
Drawn as the column's last child they lay *under* the editor — later siblings
are on top — so every press on the outer half reached the editor and the handle
never heard it. It is therefore drawn after the editor, positioned from the
column's width (`explorerSeamOverhang`), and still before the scrim and the
peek, which have to cover it.

The other half is that **a pointer moving with the button down is a text
selection**, as far as a browser is concerned, and react-native-web's responder
system terminates the current gesture the moment one becomes valid, asking
`onResponderTerminationRequest` first — which defaults to yes. Dragging left
crosses the tree's note names, so the gesture died about three points in;
dragging right crosses CodeMirror's editing host, where a selection begun
outside does not extend, so that direction never hit it. What was left answered
only a pull slow enough to stay inside the handle's own 7pt strip, the one place
on that side with no text in it. So the resizer answers `false` to the request —
`selectionchange`, `scroll` and `contextmenu` are the only events routed through
it, and none of them should end a drag somebody is in the middle of — and holds
`user-select` and the resize cursor on the document for the length of the
gesture, handing both back on release *and* on a real cancel. A page left
unselectable is a worse bug than the one this fixes, and only a reload clears
it.

The guards: `appFrameRender.test.ts` drives a real `selectionchange` mid-drag
and pins the handle's place in the row; `panels.spec.ts` drags the seam in a
browser, from the half of the handle that lies over the editor, on the fixture
with a real tree behind it. Measured against the bundle before the fix, a 45pt
pull left moved the seam 3pt and then froze.

**`explorerHidden` and `explorerWidth` stay two fields.** One number meaning
both makes a 40pt tree representable, which is exactly what the floor exists to
refuse, and re-opening would have to invent a width instead of restoring the one
somebody dragged to.

**The peek is its own region, not the drawer with its scrim suppressed.**
Resting on the folded tree's seam brings it back *over* the editor — floating,
so nothing reflows and the paragraph being read does not move — which is what
makes folding it a cheap decision rather than a commitment. It must not have a
scrim: it is dismissed by moving the pointer, and a scrim would grey out and
make inert the note being peeked at *in order to reach*. `regionsFor` promises
the scrim exists if and only if a panel is over the editor and asserts it by
naming `drawer` and `sheet`, so the alternative was to loosen that word to
"modal". A fourth arm on a union that is already `frame.ts`'s subject is cheaper
than weakening a proven invariant, and `appFrame.test.ts` fails if the peek is
folded back into `drawer`.

**`closesOnSelect` takes the presentation, not the density.** Its previous
comment predicted this: it answered `false` everywhere and said the day a
density put the tree over the document again, this is the line that changes. The
tree is over the document again — as a peek, at wide rather than compact — so
the density was never the question.

**Preferences survive a resize; modes do not.** `railCollapsed`,
`explorerWidth` and `explorerHidden` are choices about how somebody likes the
app. `explorerPeeking` and `focus` are claims about what is on the screen right
now, so `panelsClearedFor` clears them. Getting the split wrong fails in both
directions: a cleared preference is a resize that rewrites what somebody chose,
and an uncleared mode is a rotation that returns you to a stripped app.

**Focus mode removes the panels, not the instruments.** ⌘\ folds both and keeps
the status bar, which carries the save state, the conflict-check mode and the
two panel toggles — so it is the way back out, alongside Escape and a warm strip
down the leading edge where a hand goes looking for a panel that was there a
moment ago. A mode that hides its own escape hatch is one people enter exactly
once. It is also the only thing that reaches `rail: "hidden"` at a pointer
density, so that arm has left `frame.ts`'s kept-but-unreachable list and
`appFrameRender.test.ts` now names which density draws it.

**Two controls for one action, split cleanly: the seam is the gesture, the
status bar is the state.** The seam costs nothing at rest because it is revealed
under the pointer; the status bar costs nothing to find because it never moves,
is the only half a keyboard reaches by tabbing, and is the only half left
standing in focus mode.

**None of this is on a phone.** `compact` has no left panel — navigation is the
context strip and the bottom row — so `explorerToggleFor` and `focusToggleFor`
answer "nothing" there, and the closed seam is gated on the same answer rather
than on a second derivation of it. A control that folds where the chord does
nothing is a button that lies. The first render of the closed seam *was* gated
on `hasExplorer` alone and drew a seam on every phone; a render test caught it,
which is the whole argument for asking the single owner instead.

### Bold is a toggle, ⌘B belongs to the note, and the right-click menu is the web's alone

Four decisions from one ask — *"command b should make whatever you highlighted
bold, same with italics… highlight something, right click to see a menu of
different options, strike through… maybe insert a table, selecting the
dimensions of that table"* — and they are separable, so each is here with what
it costs.

**A marker verb is a toggle, on every surface.** `wrapSelection` inserted a pair
and nothing took one off, which was survivable while the only thing that ran it
was one key on the accessory bar with an undo key beside it. It is not
survivable on ⌘B, because ⌘B is *the* chord people press twice — once to start a
bold word and once to end it — and answering the second press with `****bold**`
punishes the most ordinary thing anybody does with the editor. So `toggleWrap`
in `markdownFormat.ts` is what the chord, the menu row **and the phone's Bold
key** all run. The bar did not ask for that and gets it anyway: two meanings of
Bold on two surfaces is the drift `editorSetup.ts` exists to prevent, and
`webviewBridge.test.ts` now presses the bar's key twice across the bridge to
prove the phone got the same verb rather than a lookalike.

**Which half of `***x***` a chord takes back is a rule, not an accident.**
`**words**` has a `*` immediately either side of the word, so a naive "is the
marker there?" answered yes for ⌘I, took one off each end, and left `*words*` —
the same words saying something else, from a keystroke meant to *add* emphasis.
A run of asterisks is now read the way CommonMark reads it: a one-character
marker is present only in an **odd** run, a two-character marker in any run of
two or more. That is what makes the two chords compose — bold then italic gives
`***x***`, and either pressed again removes its own pair and leaves the other —
and it is the first thing to revisit if a marker that is not a repeated single
character is ever added.

**⌘B is bold in a note and the rail everywhere else**, which needed a rule in
`keymap.ts` rather than a winner. `toggleRail` is global and declaring `"global"`
declares every scope but `"overlay"`, so before this the chord toggled a sidebar
while somebody was typing. The two are not competing for one chord: they are one
chord meaning the obvious thing in each of the two places it can be pressed, and
that is what scopes are for. **A binding that names a scope beats one that only
reaches it as `global`** — which is general, is what `resolve` does in two
passes, and is why the collision guard in `keymap.test.ts` now allows exactly
one kind of shadowing and still fails every other. The marker bindings sit at the
*bottom* of `BINDINGS`, below `toggleRail`, on purpose: in their natural group a
first-match-wins resolver would answer `bold` by coincidence of position, the
rule would be untested, and the suite would go green against a resolver that had
never learned it.

Three consequences, each a real cost rather than a tidy-up:

- **⌘B no longer toggles the rail while the caret is in a note.** That cost
  was paid before it was charged: the section above this one put the fold on
  the rail's own seam and a toggle for it at the leading edge of the status
  bar, on the argument that a panel collapsing through a chord with nothing on
  screen saying so was the defect. The chord was the only route; it is not now,
  and ⌘\ still folds both panels from anywhere including the editor.
- **The three chords are declared in `keymap.ts` and dispatched nowhere.**
  `editorSetup.ts` binds them inside CodeMirror, against the live selection,
  which is the only place that knows what "the selection" is. The declaration
  buys the two things a binding written only there cannot: the menu prints the
  real chord through `describeBinding` rather than a literal — the bug `menu.ts`
  has already had once — and the chord takes part in the collision guard.
- **`useKeymap.web.ts` now ignores a keystroke whose default was already
  prevented.** It has to: the listener is on `document` and bubbles, so a widget
  with its own keymap has already run. The latent half of that is worse than the
  ⌘B half — ⌘S is bound in `editorSetup.ts` *and* is `save` here, so the day
  `readFocus` learns to see a contenteditable (the Live Preview editor is a
  `div`, not a `textarea`, so the `editor` scope does not resolve for it today)
  one press would have written the note twice, the second write conditional on
  an etag the first had already moved: a conflict dialog over somebody's own
  keystroke.

**There is no chord for an inline code span, and none for a link.** Every
obvious one is already spoken for by something that works: ⌘E is
`togglePreview`, ⌘⇧C is the element inspector in Chrome and Edge, and ⌘K is the
palette — which is the console's main route to everywhere and worth more than a
second way to type two brackets. Both verbs are on the menu with no chord
printed beside them, which `describeBinding` already treats as a legitimate
state rather than an error.

**The right-click menu is `Menu.web.tsx` drawing `editorMenu.ts`**, the same
arrangement the file tree has had since the console rebuild, and it inherits
that arrangement's two rules unchanged: read-only means a row is *absent* rather
than greyed, and an empty list means **let the browser's own menu open**. That
last one is not politeness. Spelling suggestions live in the browser's menu and
nowhere else, and spellcheck is on in this editor by an earlier deliberate
decision (P1), so replacing that menu unconditionally would have taken away a
feature somebody had switched on. **Shift-right-click therefore falls through**,
which is the chord Firefox already spells this way and which the other engines
learn here. Paste is deliberately not offered at all: reading the clipboard is a
permission prompt in Chrome, a second confirmation in Safari and refused
outright on an insecure origin, so the row would work for some people some of
the time with nothing useful to say when it did not — and ⌘V is unaffected.

The handler also **places the caret where the click landed** unless the click is
inside the selection, because the engines disagree about whether a right button
places a caret in a contenteditable at all, and a formatting menu that acts three
lines from where somebody clicked is worse than none. `posAtCoords` measures, and
measuring is the one thing here that can throw, so a position it cannot answer
leaves the selection alone rather than costing the whole menu.

**The table picker is web-only, and the file name says so.** Hovering a
rectangle is a pointer gesture, the menu it opens from does not exist on the
native app, and the accessory bar is already at the width where an equal share
of its pill falls below the touch floor — there is no room for a ninth key. So
`TableSizePicker.web.tsx` has no native sibling, and an iOS note gets tables by
typing them exactly as it did before. That is a stated gap, and the same gap
covers **strikethrough**, whose ⌘⇧X has no touch route on the native app either.
`keymap.ts`'s standing rule — no command it names may be the only way to do
something without a keyboard — is satisfied for bold and italic by the bar and
for strikethrough only by the web build's own long-press, which raises the same
menu as a bottom sheet. The place the missing keys would land is the bar, on the
day it stops being full.

Two smaller things fell out and are worth recording so they are not undone:
`place`/`fixedAt`'s flip-don't-clip arithmetic moved to
`design/components/popoverPlacement.ts` because the picker is the second thing
that opens at a pointer and a second copy of that rule is the copy that gets
fixed once; and a GFM table cannot interrupt a paragraph, so a table asked for
on a line that already has text is inserted *after* that paragraph with the
blank line the grammar requires — without which the button's whole output is a
row of literal pipes in the middle of somebody's sentence.

