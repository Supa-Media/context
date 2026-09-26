# App and console — note editing surface

### A note may declare the mode it opens in, and the person still outranks it

Reading mode is a *session* mode and the section above it says why: it is how
you are working, not a property of the file, and resetting it on every selection
"makes it a property of the note rather than of how you are working, and then it
belongs in the file rather than here".

For one kind of note it does belong in the file. A page whose content is a
` ```form ` fence is drawn as a fillable form **only while the note is read** —
that is the rule directly above, arrived at for reasons that are not going to
change — so the one page in the product whose purpose is to be *used* rather
than written opened as a code fence, and everybody who visited it had to find
the eye in the trailing group first. The owner's words: forms should "be easily
sent without more clicks".

So a note may say so in its frontmatter, and `files/viewMode.ts` reads it:

```yaml
---
view: read      # or reading, preview; and edit, editing, source
---
```

Four things are decided here rather than left to the next reader.

**It is frontmatter, not a key in the `form` block.** The question is "how does
this page open", which is true of a note with no form in it at all — a
long reference someone only ever reads, a diagram page — and a block that
declares it would answer it only for pages with blocks. It also keeps
`forms.md`'s rule that the fence declares the response path and nothing about
presentation.

**`obsidianUIMode: preview | source` is read too, and ours wins on a tie.**
These buckets are open in Obsidian while the console is looking at them, and
that is the key Obsidian already honours for exactly this. Honouring it costs
one row in one table and means one line in the file rather than two that can
disagree; refusing it would have meant every form page carrying both.

**A value neither table knows is ignored rather than guessed at.** The note
opens however the person was already working, which is what every note did
before this existed. `view: readonly` is not "near enough to `read`": a key
that half-works is worse than one that does nothing, because the author
believes they were understood.

**The declaration is a default, so it is a second layer and never the mode
itself.** `readMode.ts` holds the person's `chosen` and the open note's
`declared`, and everybody reads `declared ?? chosen`. The first version
collapsed them — a declaration simply called `setReadMode` — and it is wrong in
the direction nobody reports as a bug: opening one form page would put the
*session* into reading mode, and every ordinary note opened afterwards would
come up unwritable with nothing on screen saying why. A file may decide how it
is opened; it may not decide how you work. For the same reason the declaration
is applied once, when the note's identity changes: pressing the pencil wins for
as long as that note is open, which matters because the one place a `form` fence
that will not parse can be fixed is its source.

What this costs, stated: a note stored encrypted declares nothing the console
can see, because what it holds is the ciphertext and the envelope's plaintext
frontmatter is the encryption marker rather than the note's own. Such a note
opens in the session's mode. And nothing *writes* the key — `frontmatter.ts` is
a reader and gains no serializer for this, so setting it is typing a line, or
asking an agent to.

**The tests that fail if this is reversed**: `a declaration does not follow you
onto the next note`, `the person's own mode still persists across notes` and
`the pencil outranks the file, and keeps outranking it` in
`apps/mobile/__tests__/noteViewMode.test.ts` — the three that collapsing the
layers turns red while every parsing test stays green — plus `a note that
declares \`view: read\` opens read, with no press at all` in
`noteChrome.test.ts`, which is the only one that fails if `BrowsePane` stops
calling the hook.

### The `--lp-*` palette is a contract between two hosts, and a missing one fails silently

Every rule drawn inside the note editor names its colours as `--lp-*` custom
properties rather than as values, because the identical stylesheet runs in two
places: the browser, where `LiveEditor.web.tsx` sets them from `useColors()`,
and the iOS `WebView`, where they arrive over the bridge from `themeVars`. A
colour imported from the design tokens at the top of a shared module would be
the *build's* palette rather than the viewer's.

**The failure mode is why this is a decision and not a convention.** An unknown
custom property does not fall back and does not error: it makes its whole
declaration invalid at computed-value time, so `color: var(--lp-missing)`
resolves to `inherit` and the text silently takes whatever colour the app around
the editor happens to be using. That shipped. The web half declared six of the
set, `--lp-content` was not among them, and CodeMirror's own base theme
(`li[aria-selected] { background: #17c; color: white }`) won the completion list
— white ink on the light ground — while every form label, every input, the
status line and the link tooltip lost their colour by the same mechanism. All of
it was correct on iOS the whole time, which is exactly why looking at the app
never found it.

So the guard is a **relationship rather than a list**: `liveEditorMount.test.ts`
mounts the editor, reads every stylesheet actually in the document, and requires
every `--lp-*` any of them reads to be one the base `.cm-lp-root` rule declares.
Reading the live document rather than importing the themes is what makes a theme
the test forgot to import impossible to miss — the completion list's theme lives
in `linkComplete.ts`, a different file from the one that declares the palette,
and that distance is the whole reason the two drifted. Restricting to the base
block is what stops a property declared only inside the compact media query from
passing while being undefined at every width above the breakpoint, which is the
desktop console, which is where it was reported.

**A hairline is a token, not a fill.** There was no `--lp-line` for a long time,
so anything that wanted an edge borrowed `--lp-code-bg` — the code fence's
*background*, which is `#F5F5F5` on a `#FFFFFF` ground. Every such border was
invisible in light mode, and two separate pieces of work reached that conclusion
independently within a day. `--lp-line`, `--lp-line-strong` and
`--lp-focus-ring` come from the palette's own `line`, `lineStrong` and
`accentDim`; the guard above is what keeps both hosts declaring them.

### One save status, and a control only where pressing it does something

Measured in a real browser against `/e2e-fixture`, at 1440×900: the foot of a
resting note carried the sentence **"Saved in your bucket"** at x=16 and a grey
pill reading **"Saved"** at x=1344 — same row, same moment, same claim, two
visual languages, opposite ends of the window. The same note at 390×844 carried
the sentence alone. So the console said one thing twice, and only on the screen
with the most room to say it once.

The sentence is the half that stays. `NoteEditor`'s own header calls it the
strongest promise in the product, and it is the only half that can tell the
truth about the two states that reach it falsely — a queued draft is on this
device and not in the bucket, a cached body came off this device — which a
one-word pill has no room to do.

The pill is not deleted, because in two states it is not status at all:
`saveButton` is pressable exactly where autosave refuses, a failed save and a
conflict, and the manual route has to stay reachable there. So the rule is the
one that keeps that reason and drops the duplication: **the save control is
drawn when pressing it does something, and not otherwise.** `NoteEditor`'s
status row reads `button.disabled` as *whether to draw this*, not as *how it
should look*.

Every arm it removes is an arm whose sentence already said the same thing, in
words that say it better: `Saved` under "Saved in your bucket", `Saving…` under
"Saving…", `Queued` under a queued draft's own message, and `Read-only` and
`Encrypted` under the notice at the head of the note rather than one word at the
foot of it. `saveButton` still computes all of them and `autosave.test.ts` still
checks all of them — what changed is which reach the screen.

What it costs: a person on a pointer layout no longer has a permanent target at
the foot of the note to aim at, so "where is Save" is answered by the state
rather than by muscle memory. That is the trade, and the states where somebody
actually needs it are exactly the states that still draw it.

The guard is `offlineEditorRender.test.ts`'s "the save status at a pointer
width", which mounts the editor at 1440 and at 390 and asserts the same save
controls at both — and asserts each width alone, because `mount` fires a
`resize` that every editor still on screen listens to, so two held open and
compared afterwards compare one width against itself. Written that way, the case
was green against the defect it exists to catch.

### The browser-reachable console is the console, at every density

`/e2e-fixture` is the only console in this repository anybody can open in a
browser — every other route wants a session and a deployment — so it is what the
WebKit suite drives, what a screenshot of "the console" is taken against, and
what a person looking at this product in a real browser is looking at.

It was the phone console at every width. `E2EFixtureScreen` wires `BrowsePane`
under a `NavBandProvider` exactly as the console layout does, and `BrowsePane`
draws that band at compact only, because at medium and wide the contexts are
`ConsoleRail`'s — one switcher per density, never two. The fixture mounted the
compact half and not the pointer half, on the argument that `AppFrame`'s regions
were not what the WebKit cases press.

Measured in Chromium at 1440×900, that argument's bill: the whole console
answered **three** `[role=button]` elements — an avatar, one breadcrumb crumb
and the save pill — and a person could not reach another context at all. The
same fixture at 390×844 drew `@lk` and `@public-worship` above the path. A
reachable-contexts affordance visible on a phone and absent on a desktop is
backwards, and "a session resolves to a *set* of accessible contexts" is the
product rather than a layout preference.

**The product was right the whole time**, which is the part worth recording: the
rail has carried the contexts at medium and wide throughout. What was missing is
that nothing said so. `consoleChrome.test.ts` asserted the strip at 390 and
nothing at 1440, so the claim that the console has a switcher at every density
was resting on nobody having checked — and the fixture, which is what people
check *with*, reported a defect the product does not have.

So: the fixture takes the density decision the way the product takes it
(`densityFor` and `regionsFor`, not a width literal) and mounts the real
`ConsoleRail` in the mode those functions answer, with the account block in the
rail's foot where the product puts it. `AppFrame` is still not reproduced — the
column is a plain `View` at `layout.railWidth`, and the hairline and surface
fill stay that component's, pinned by `appFrameRender.test.ts`.

Two guards, deliberately in different places. `consoleChrome.test.ts`'s "every
context this account can reach is on the screen" asks the **product** the
question at 390 and at 1440 and does not care which component answers — its mock
grew a second context, because a one-context account renders identically whether
or not a switcher exists. `fixtureConsoleDensity.test.ts` asks the **fixture**
the same question, and asserts the strip and the rail are never both on one
screen. Sabotage: `rail: "hidden"` in `regionsFor`'s wide arm fails six cases
across the two files.

What it costs: `settings.spec.ts`'s pointer-width case reaches Settings through
`rail-settings` rather than the compact account menu, because the compact block
is no longer drawn at that width — one control where the product has one, rather
than a stand-in for a region that was missing.

### The note is a measured column, and the demo note stopped faking one

Measured in Chromium at 1440x900: the element holding the first sentence of the
console's own demo note was **1160px wide, with `max-width: none` on every one
of its first eight ancestors**. Prose was full-bleed across whatever width the
editor pane had — about 150 characters to a line, roughly double the 60-75 that
is comfortable to read — and there was no `max-width` anywhere in either of the
editor's two stylesheets.

**Why nobody had seen it.** `placeholderData.ts` authored
`1-projects/context-lc.md` as hard-wrapped source lines of about fifty
characters, and that note is `defaultSelection` — what the console opens on,
what the e2e fixture shows, and what every screenshot of the editor has ever
contained. The newlines were doing the wrapping. A reader saw a tidy column that
the layout had nothing to do with, so every visual check of this editor passed
while a real note, written the way people write them, ran to the full width of
the window. The fixture is now normal unwrapped paragraphs — same wording, the
browser's line breaks — and re-wrapping it would hide this whole class of bug
again.

**The measure is `--lp-measure`, one value for both densities, relative to the
type rather than in pixels.** `layout.readingMeasureEm` is 36, so the column is
36 times the note's own font size: the same line at 14.5px beside a file tree
and at 16px on a phone, where a pixel width would have been two numbers to keep
in step. Measured in a browser, 36em is 522px in the console's face and holds 68
characters; prose in a system sans averages 0.45-0.55em a character, so it lands
between about 65 and 80 across faces against a comfortable band of 60-75. On a
phone it cannot bind at all — 342pt of text inside 24pt gutters is far narrower —
so `--lp-pad-x` still governs there, which is the point rather than an accident.

**`em`, not the `ch` that nominally means "characters", and CI is why.** The
first version of this was `62ch`. `ch` is the advance of the digit zero, so it
tracks a face's *digits* rather than its prose, and the two diverge: the same
declaration measured **75 characters in Chromium and 91 in WebKit on the same
Linux runner**, which the WebKit job caught before this merged. `ch` was
ambiguous a second way as well — a font-relative length inside a custom property
may be resolved where the property is declared or where it is substituted, and
engines differ; the note's wrapper is Times New Roman at 16px while the note is
a sans at 14.5px, so those are two different lengths. So the property now
carries a **bare number** and the rule that draws the text multiplies it by
`1em` there, against the type it is measuring. The unitless value is asserted on
both hosts: a unit sneaking back in is that ambiguity returning silently, on one
engine only.

**Nothing is allowed to be wider than the prose.** The constraint is on
`.cm-content` rather than on `.cm-line`, because a table, a form and a rendered
diagram are block children of the same element: measure the lines alone and each
of those starts at a different left edge from the paragraph above it, which
reads as broken layout rather than as a wide table. A wide table gets its own
horizontal scroller (`.cm-lp-grid`, which already had one) so it stays inside
the column instead of dragging the document sideways.

**It is padding, not `max-width`, and that is the one non-obvious line.**
`max-width: var(--lp-measure); margin-inline: auto` draws exactly the same
column and was measured and rejected: it leaves `.cm-content` 572px wide inside
a 1192px pane, so a click in the 310px either side lands on `.cm-scroller`, the
editor never takes focus, and clicking beside a line to put the caret in it does
nothing. That is half the note's apparent area no longer being the editing
surface — a worse bug than the one being fixed, and an invisible one, since the
page looks right. So `.cm-content` keeps the pane's full width and the column is
cut out of it with `padding-inline: max(0px, calc((100% - var(--lp-measure)) /
2))`: CodeMirror still maps a click in the margin to the nearest position, and
the `max()` floor hands the width straight back once the pane is narrower than
the measure, which is the phone. `readingMeasure.spec.ts` clicks in the margin,
so the tidier-looking recipe cannot come back quietly.

**It is declared twice, and that is the whole of PR #487's lesson.** The same
stylesheet runs inside the iOS WebView with the palette arriving over a bridge,
and an undeclared custom property makes its *whole declaration* invalid at
computed-value time — not an error, not a fallback. So `--lp-measure` is in the
base `.cm-lp-root` rule (`LiveEditor.web.tsx`), in the guest's `:root`
(`files/webview/styles.ts`), and in `themeVars` (`files/webview/host.ts`), and
`liveEditorMount.test.ts` and `webviewBridge.test.ts` hold that relationship
from both ends.

**The guard that proves it binds is not in Jest.** jsdom lays nothing out, so no
unit test here can tell a `max-width` that binds from one that does not — which
is exactly the state this editor was already in.
`e2e/webkit/readingMeasure.spec.ts` drives the built web export in a real engine
at 1440x900 and at 390x844 and asserts the rendered **column in em** (tight —
that one is the layout's own arithmetic) and the **character count** (loose —
that one is the font's), that the column is centred and its margins still take a
click at the first width, and that `--lp-pad-x` alone governs at the second. It
measures the line box rather than `.cm-content`, because `.cm-content` is
deliberately still the full width of the pane, and it logs the width, the em
multiple, the count and the resolved face on every run, so a failure names the
font it is arguing with rather than only a number.

### An icon reaches for a path only when a rectangle cannot hold one weight

`Icon.tsx` draws the set from `View`s — borders, radii, transforms — and the
header argues at length for why, against both an icon font and
`react-native-svg`. Two of the forty-odd icons are now stroked `<Path>`s
instead. This is the rule that keeps it at two, and the evidence that earned
the exception.

**The refusal had two grounds and both expired.** The first was the dependency:
native, so it would land in `native-deps.json` and need a fresh development
build before anyone saw an icon. It has been in `package.json` at 15.12.1 and in
`native-deps.json` `core` since the baseline was over-provisioned ahead of the
first binary — every build already carries it, so there is no build to wait for
and nothing to gate. The second was the load-bearing one: *"there is no icon
here with a curve a rectangle cannot fake."*

**The eye is that curve, and it took three attempts to say why.** A rectangle
*can* fake a curve. What it cannot fake is **a curve at constant stroke
weight**, and every failure was that one fact arriving in a new disguise:

1. A `shackle` over a `cradle` — the padlock's arch and its mirror. Those carry
   left and right borders, which closed the almond into a capsule with a dot in
   it. That is a toggle switch, and it read as one in the toolbar.
2. One rounded border per lid, then a semicircle stretched sideways to kill the
   straight run a clamped corner radius leaves across a wide shallow arc. That
   removed the switch and exposed what the borders had been doing all along: a
   corner between borders of different widths is drawn as a wedge running to a
   point, so the stroke arrived at each canthus at nothing.
3. The true arc walked as round-capped `bar`s. Uniform weight at last — and the
   caps that let consecutive segments join are the same caps that bulge past a
   curve this tight, so it read as a beaded chain.

A stroked path has none of those failure modes, and the reference the owner
supplied — one weight the whole way round, lids meeting in points, an iris large
enough to nearly fill the almond — is not reachable from `borderRadius` at all.

**So: reach for a path only when the drawing needs a curve at constant weight.
Everything a rectangle can fake stays a rectangle.** Without a stated trigger
this becomes a slow, unargued rewrite in which forty working drawings are
churned one at a time for no gain. `eye` and `pencil` qualify; nothing else in
the set does today.

**What a "simplification" back to borders would cost**, and the guards that
fail. Path data stays in the same unit space (`viewBox="0 0 1 1"`) and the
weight is still `strokeFor(size)`, expressed as `strokeWidth = w / u` — so a
path icon is held to every set-wide claim the others are, rather than quietly
dropping out of them. `icons.test.ts` reads the geometry back out of the DOM:
it samples arcs rather than reducing them to their endpoints, because an arc's
bulge is the part that leaves the box, and it holds `eye` and `pencil` to
"stays inside its box" in the stroke's own terms — half the weight hangs outside
the outline, and that half has to fit too. The guard that is the actual finding
is **one weight all the way round**: it is cheap, exact, and it is the thing
that was wrong in all three earlier attempts. Sabotaged three ways — the iris at
a different weight, the eye widened until the stroke overhangs, the outline left
open — each fails exactly one test and no others.

### The read toggle's glyph is the act, so the accent fill is gone

The note's trailing capsule carried one eye, lit by `selected` while reading.
The argument for the fill was real: one mark cannot draw both "will hide the
markup" and "will bring it back", so the state went into the fill and the label
carried the act — the same rule `ICON_NAMES` states for the padlock that group
used to hold.

Two marks can draw it. The control now shows an **eye while you are editing**
(press it to read) and a **pencil while you are reading** (press it to edit), so
the icon and its `accessibilityLabel` say the same thing at last.

**Once they do, the fill is not merely redundant — it is wrong.** It would light
the *pencil*, and a lit control in this chrome means "this mode is on", while
the pencil means "press to start editing". Keeping both would be one signal
contradicting the other on an unlabelled 20pt target.

`_layout.tsx` (the phone) and `BrowsePane.tsx` (every pointer density) take the
same swap, because it is one control in two places rather than two controls.
`noteChrome.test.ts` asserts the label and the glyph together, reading
`data-icon` — which is why `Icon.tsx` puts the name in the DOM at all: a drawing
has no text, so without it "the mark changes when the mode does" is
unassertable.


### Properties are edited in the panel, one line at a time

The Properties panel was a reader, on the argument in `frontmatter.ts` that a
YAML writer which misunderstands a line rewrites somebody's note into something
they did not type. The consequence was that nobody could edit a property: on a
pointer layout the block is hidden in the editor until the caret finds it, a
phone's editor never holds it, and the panel's last row said "Add property —
from a desktop, for now". An owner reported it as a bug, which it was.

The panel now changes a value in place, removes a property with its ×, and adds
one from its last row. The write is `setNoteProperty`, the one a folder list
already uses for a status: it changes that key's line and no other byte, and
refuses rather than guesses when what it wrote would not read back as the value
given. The panel only offers rows the reader and the writer agree about — a
top-level `key: value`, the last of a repeated key, not a list, not a nested
map's child, and never `visibility`, which `privacy.md` decides. Everything else
is still drawn, read-only, and still editable in the file. The change goes
through the editor's own `onChange`, so it saves, merges into a collaborator's
typing and undoes like a keystroke; reading mode and read-only access show no
controls at all.

A "simplification" to a generic YAML serializer would cost the property the
writer rests on: every other byte of somebody's note stays theirs.
`apps/mobile/__tests__/notePropertiesEdit.test.ts` fails if a change touches
another line, if a list or nested child is offered for editing, if adding
overwrites an existing key, if a reader is offered controls, or if the phone
path writes the body instead of the note.
