# App and console — callouts, plugins, and the rail fold

## A callout is a box, and `[!type]` never reaches the reader

Reported with two screenshots side by side — the Bible Reference plugin's
output in Context, and the same note in Obsidian — and one sentence: *"this
plugin shows up weird, compare to how it shows up in obsidian."*

**It was never a plugin bug.** The plugin writes
`> [!bible] [John 3:16 - NIV](…)`, which is an ordinary Obsidian *callout*, and
this editor had never heard of one. `[!bible]` parsed as a shortcut link, its
brackets were hidden like any other `LinkMark`, and the reader was left with the
word `!bible` underlined in blue in front of the reference. Every `[!note]`,
`[!warning]` and `[!tip]` in anybody's vault read the same way; a plugin is only
what finally put one on screen next to its original.

Callouts are Obsidian's extension rather than CommonMark, so lezer has no node
for one and `callouts()` reads the first line of a `Blockquote` the tree already
found — the same shape, and the same stated reason, as `frontmatterRange`.
Matching on a line the tree has *already called a blockquote* is what keeps
`[!note]` in the middle of a sentence from becoming a box.

**The `>` goes too, and that reverses a rule this file's neighbour states
flatly.** `HIDDEN_MARKS` in `livePreview.ts` is emphatic that `QuoteMark` must
never be hidden — "a blockquote with its `>` removed reflows into the paragraph
above it and the reader cannot see the quote at all". Exactly right for a quote
and exactly wrong for a callout, because the box says the same thing the `>` was
saying. It is hidden per callout rather than by widening that set, so a plain
quote keeps every one of its marks, and per *line* rather than per callout, so a
caret on one line does not bring back the `>` on the four nobody is editing.

**No per-type colours, no icons.** Obsidian has thirteen callout types and
thirteen colours; each would be another `--lp-*` token crossing the WebView
bridge, against this area's standing restraint about palette-specific tokens.
The book icon in the report's screenshot is not Obsidian's either — it is the
plugin's own stylesheet, and Context does not load a plugin's CSS into the
trusted realm. Folding is not implemented, and the `+`/`-` that asks for it is
consumed as part of the marker rather than left behind: a callout that will not
fold is legible, and half a marker on screen is the bug this fixes.

**The completion list stopped assuming its own content at the same time.** Every
completion this console wrote for itself is a note path or a form keyword — a
few words, and a row that never needed a width. A plugin's suggestion is
whatever its `renderSuggestion` drew, and Bible Reference's is the verse: two
hundred characters on one unwrapped line, so the list grew to fit and ran off
the side of the screen. Wrapped and clamped to three lines rather than
ellipsised, because a verse cut at one line cannot be told from the next one.

**What a simplification costs.** Dropping the marker replacement is the reported
screenshot. Widening `HIDDEN_MARKS` instead of hiding the `>` per callout takes
the marks off every plain quote in every note. Revealing per callout rather than
per line jumps four lines of text sideways under a moving caret. Letting the
line walk stop on the quote's `to` draws an empty row of box under every callout
— which jsdom reported as fine and Chromium drew. `callouts.test.ts` holds the
decisions and `e2e/webkit/callouts.spec.ts` holds that they reach a screen; six
sabotages confirm them, and a seventh was removed rather than kept, because a
`Decoration.mark` inside a `Decoration.replace` paints nothing and no test could
tell the difference.

## A plugin row's switch is the press it replaced, and a choice never becomes one

Reported from a phone, and already quoted in `pluginRow.ts`: *"soooo much
jargon text; people just want to enable or disable a plugin."* The list was cut
to one question per row on the back of that, and the control it was left with
was still a button reading Start or Stop — the same press, drawn as a thing you
read rather than a thing you flick. Every other plugin manager people have used
puts a switch there; ours had the word.

**So the row has a switch, and exactly two presses are allowed to become one.**
`pluginRowSummary` already split them: start and stop are complete on the row
because everything they need has been granted, while anything with a choice
inside it opens a door and says so with an ellipsis. `pluginRowControl` is that
same split at the control, and it lives beside the summary rather than in the
panel so a second surface cannot quietly widen it. A switch that turned a
plugin on for the first time would have to pick capabilities and hosts on
somebody's behalf, which is the consent screen skipped by a control too small
to hold the question — and it would still render, still look right, and still
pass every test about wording. `pluginRowSummary.test.ts` names both doors,
`Enable…` and `Approve…`, because a test naming one of them goes green on a
mutation that special-cases the other.

**The switch is the accent, never a status tone.** Graphite and Paper spend one
hue on "here, active, yours", and a switch is the clearest thing in the console
that is yours — but `ok` green on a healthy plugin would make it a status light
somebody can press. The two halves come apart on the row that matters most: a
plugin that crash-looped is **off** without anybody having turned it off, so
its switch reads off while its pill keeps saying *Stopped itself*. The control
says what you set; the pill says what happened. `pluginSwitch.test.ts` asserts
the track paints `accent` and specifically not `ok`, which is what fails if
somebody ever "simplifies" the two into one colour.

The simplification this resists is the obvious one — draw the switch wherever
there is a press, colour it by health — and what it would cost is a consent
screen and a status vocabulary, neither of which the row would look any
different for having lost.

## The rail folds into the switcher, and the column it occupied goes to the note

The owner's words, looking at four screenshots of the console beside Obsidian
and Notion: *"the design system for context.lc is non-existent and its very
generic, and does not feel cohesive."* The palette, the type scale and the radii
were the first three answers. This is the fourth, and it is the only one that
changes what is on the screen rather than what colour it is.

The console drew **three columns**: a 216pt rail of workspaces and app
destinations, a 260pt file tree, and the note. The design canvas draws two —
the tree and the page. Three columns on a 1440pt window leave the note 964pt
before its own gutters, which is why the measure looked cramped in a window
nobody would call small, and why the app read as busier than the two products
it was being compared to.

**Five workspaces and four destinations do not earn a permanent column.** They
earn a menu under the name already in the title bar, which is where you look to
know whose notes are open. `features/console/SwitcherMenu.tsx` is that menu, and
it carries `railGroup`'s list unchanged: one group, the personal workspace
pinned first and marked "yours", everything after it in the order the control
plane sent, the claim entry in the pinned top slot and "New workspace" at the
foot.

### What it reverses, and what it only moves

**"The rail is one list, with the personal workspace pinned to the top"** is
*moved*, not reversed. Same `railGroup`, same pin, same mark, same two offers
under the same two conditions — a different container. `railGroup.test.ts` is
untouched and still passes, which is the evidence rather than the claim.

**"The contexts moved into the scroller, because navigation is not a verb"** is
untouched. That decision is about a phone, where a strip of pills lay across
somebody's note at every scroll position; `compact` still has no rail, still
draws `NavBand` inside the scroller, and still pins the account mark alone in
the corner. `topBarLeadFor` is the one function that says which of the two a
density gets, and it exists so the reachability guard has an input again —
that guard used to read `Regions.rail`, and a rule whose input has been deleted
is a rule that agrees with everything.

**"Both left panels fold, and the seam between them is the control"** loses half
its subject. There is one left panel, so there is one seam and one status-bar
toggle. `PanelToggle`'s third state went with the rail: `half` meant "narrowed
to its icons", which had to exist because `icons` was not `off` — the rail was
still there and still navigable — and the tree is drawn or it is not.

**⌘B is repointed rather than retired, and an earlier draft of this change said
the opposite.** That draft argued: *"quietly moving a shortcut onto a different
panel than the one its user learned is worse than a shortcut that stops doing
anything."* The premise was wrong. Nobody learned "⌘B narrows the workspace
column"; they learned what VS Code, Zed and Obsidian all mean by it, which is
*fold the left panel and give me the width*. There is exactly one left panel
now, so that is what it does, and ⌘⇧E is gone rather than kept beside it —
`keymap.test.ts` allows a command exactly one chord, which is what keeps
`describeBinding` from having to choose which alias to print. The collision with
`bold` in a note is unchanged, and so is the rule that settles it.

### What the fold cost, and where it was paid

**Right-click on a workspace.** `ContextRowMenu` hung off every rail row through
`RightClickTarget`, which reached the real DOM node to attach a `contextmenu`
listener react-native-web would otherwise strip. A menu row has no second menu
behind it, so that wrapper is deleted and a pointer layout has no right-click on
a workspace at all. The phone's own gesture is untouched: a long press on the
strip's pill, the same component, same two verbs.

The two verbs are what had to be paid, and they are rows in the switcher's own
menu: **Settings…**, and **Leave**, offered only on the context you are standing
in and only where `leaveWorkspace` would allow it — a row offered on your own
workspace is a press whose only outcome is `OWNER_CANNOT_LEAVE`. One row rather
than one per workspace, because "leave" is a verb about where you are standing
and a list of five workspaces each with a destructive row beside it is a menu
you stop reading.

Without that row this change would have taken the only door out of a shared
context on a desktop, which is the kind of quiet subtraction a fold is most
likely to make.

**What a simplification costs.** Bringing the rail back is the third column and
the cramped measure; it is also `Regions.rail`, `Regions.navToggle`,
`FrameState.navOpen`, `FrameState.railCollapsed`, `railToggleFor`, `AppFrame`'s
`rail` slot and `closeNav`, the rail column, the rail seam, the nav sheet and
`ConsoleRail.tsx` itself, all of which went in one change because `frame.ts`'s
own list refuses a representable region with nothing that can draw it. Dropping
the Leave row leaves a shared context with no way out on a pointer layout.
Dropping the claim entry's top slot puts a placeholder under the rows it stands
in for. Leaving ⌘B unbound leaves the chord every editor uses doing nothing, and
leaves `keymap.ts`'s scope-precedence rule with no live example to be tested
against.

**The tests that fail if it is reversed.** `appFrame.test.ts` ("a pointer layout
is the tree and the note, and nothing more"; "and the leading end of its title
bar is the switcher"; "`railToggleFor` is gone, and ⌘B belongs to the one panel
that is left"), `appFrameRender.test.ts` (the account slot, the seams, the one
status-bar toggle), `consoleIdentityChrome.test.ts` (the whole list, the pin,
the mark and both offers, read out of the opened menu),
`routeReachability.test.ts` ("a control `SwitcherMenu` draws is claimed as the
switcher", and `REGION_DENSITIES` read off `topBarLeadFor`),
`meetingsEntry.test.ts`, `ownContextPrompt.test.ts`, `consoleChrome.test.ts`,
`signOutHygiene.test.ts` and `fixtureConsoleDensity.test.ts`. Fifty-one
assertions across eight suites named the rail as the container they lived in;
every one was rewritten rather than deleted, because they are the reversal
guards of the decision this moves.

## A picture of the application does not invert with the page it sits on

The landing page is drawn in whichever palette the visitor's system asks for.
Two objects on it are drawn in graphite regardless, and the design canvas is
explicit about it: the endpoint bar — the MCP address you copy into a client —
and the hero's application window are both graphite on `Landing-Hero`'s **paper**
board as well as its dark one.

That is not an oversight in the canvas and it is not a theming bug. Both objects
are *depictions of software*, quoted inside a page that is not that software. A
terminal is a dark thing; a screenshot of an application is a screenshot,
whatever the brochure around it is made of. Re-tinting either to paper produces a
slightly different paper — which is not a different kind of thing, and is exactly
the effect that makes an embedded screenshot read as a panel instead of a window.

So the palettes carry `appSurface`, `appInk`, `appAccent`, `appChip` and
`appChipHover`, identical in both worlds.

**What a simplification of this would cost.** The obvious simplification is "let
them follow the palette like everything else". On paper that turns the hero's
window into a cream rectangle with cream chrome, and the endpoint bar into a
lighter stripe on a light page — both lose the edge that says *this is a
different surface, belonging to a different thing*. The hero window stops looking
like the product and starts looking like a section of the website. The page's one
job above the fold is to show the product.

The opposite simplification — hexes at the call site, no tokens — is what was
written first, and `paletteDiscipline.test.ts` rejected it correctly. A component
that names a colour is a component no palette can answer for; "this one is meant
to be fixed" is a claim that has to live somewhere a reviewer will find it, which
is here and in `tokens.ts`.

**The tests that fail if it is reversed.**

- `theme.test.ts`, *"no token was left as its dark value"* — this rule's own
  hazard, and the reason the exception is an allowlist rather than a relaxed
  comparison. That test exists to catch a token copied into `lightColors` to make
  the types line up and never given a light value, which is indistinguishable
  from a token that is *deliberately* the same. Each `app*` name is listed
  explicitly; everything else must still differ.
- `theme.test.ts`, *"every allowed exception is actually fixed, not merely
  listed"* — the allowlist's own guard. A name left in it after its token started
  differing protects nothing, and a name mistyped into it silences nothing while
  looking as though it does.
- `paletteDiscipline.test.ts` — no component may name a colour, so a third fixed
  surface cannot be added as a literal without this decision being read first.

**What this does not license.** Two objects, both depictions of the application.
A third one is not covered by "well, the other two do it": the rule is about what
the object *is*, not about wanting a dark box. Anything that is genuinely part of
the page — a card, a callout, a band — inverts.

## A sort number is filing, so the console draws the name and keeps the number

PARA only works in order. `1-projects` has to come before `2-areas`, and every
tool that reads the bucket — a listing, Obsidian's sidebar, the Files app, `ls`
— sorts one way, alphabetically. So the order has to be *in the name*. That is
not a Context convention we could drop; it is how ordering survives being
handed to somebody else's tool, which is what non-negotiable #1 is about.

The cost is that the number is then drawn back at the reader on every row, in
every crumb, on every tab, in the one product whose claim is that the files stay
pleasant to live in. The owner's framing, asking for this:

> for numbers i agree that it's not sexy to have, but when you organize in para
> you need to have the folders in a specific order, and most file systems just
> do alphabetical

The question that answers it — put to them by somebody they were explaining the
layout to — was whether the number could be invisible: an attribute the console
sorts by rather than something it renders.

It can, and it already is: the number is filing, exactly as `.md` is filing.
`displayName` had been dropping the extension from what a row draws since the
tree existed, with `TreeRow.name` and `TreeRow.path` carrying the truth beside
it. **`withoutSortPrefix` is the same rule for the other end of the name**, and
`docs/decisions/` has no argument to re-run: it is the argument for the
extension, applied where the reader already agreed with it.

Backwards compatible in both directions, and that is the reason this is cheap
rather than clever. An existing bucket needs no migration to look better,
because nothing is written. A context whose folders draw without numbers is
still, byte for byte, a context any other tool opens in order — so the person
who leaves with their files (non-negotiable #1) leaves with the ordering intact,
and never finds out this happened.

**Where the number goes, and where it stays.** The split is not
surface-by-surface taste; it is one question asked of each string — *is this
naming a thing to a reader, or addressing a key?*

- **Dropped**, because these name a thing: tree rows and folder rows
  (`displayName`), every breadcrumb segment (`crumbsFor`), tab labels and the
  folder that disambiguates two of them (`tabLabel`), the note's inline title
  when it falls back to the filename (`noteHeading`), a folder's own heading on
  its page, Recent's rows and the folder line under them, the row menu's title,
  the "Currently team — from …" line, the share dialog's heading, and the
  toasts that report a move, an archive or a delete.
- **Kept**, because these address a key: Rename's field — which is the answer
  to "but when editing you can see it", and the one place somebody changes the
  number — the move picker and the command palette, `[[link]]` completion
  (whose `insert` is a path being written into a note), the permanent-delete
  sentence, and every operation anywhere, all of which go by `path`.

**What a simplification of this would cost.** The tempting one is a wider
pattern: `/^\d+[-_.\s]+/`, which is what `titleFromPath` and `linkLabel`
already use. Both are allowed to be wider because both are *inventing a title*
and may refuse — "a card with no title is honest". This rule draws the
customer's own filename back at them, so being wrong is not a missing card, it
is a row naming a file that is not the one on disk. Hence one or two digits (a
year is four), a hyphen only, nothing stripped when nothing is left, and never
when another digit follows — `2026-09-18.md` keeps its year, `12-25-christmas.md`
keeps its month, and `4-archive/2026-08-26T09-14-02-113Z/…` keeps the folder
`restoreTargetFor` reads a path back out of. **When in doubt, draw what is on
disk**: showing a number nobody wanted is untidy, and hiding half of a date is a
lie about somebody's file.

The other simplification is to make the label depend on its siblings, so
`1-plan` and `2-plan` do not both draw as `plan`. That is rejected and the
collision is the accepted cost: a label computed from whatever else happens to
be loaded reads differently for one folder in the tree, the tab strip and the
crumb, and the tab strip is the only place a collision has a bounded answer (it
qualifies with the folder, and already does). Two siblings deliberately given
one word is a naming problem its owner can see and fix, in a Rename that spells
the number out.

**The tests that fail if it is reversed.** `fileEditor.test.ts`, "the display
name" — the whole of PARA drawn short, a date left alone in four shapes, a
number with nothing after it kept, a separator that is not a hyphen kept, the
two halves re-joining to the original name, the collision pinned as stated, and
`TreeRow.name`/`path` unchanged beside a trimmed `label`.
`breadcrumbPath.test.ts`, "every segment drops its sort number" and "no trim
reaches the path a segment opens" — the second is the one that matters, because
a trim leaking into `crumb.path` asks somebody's bucket for a folder that is not
there. `fileTabs.test.ts`, "a sort number is dropped, and the collision test
sees the same name" — `1-plan.md` and `plan.md` both draw `plan`, so a collision
test on the untrimmed name would leave two identical tabs.

