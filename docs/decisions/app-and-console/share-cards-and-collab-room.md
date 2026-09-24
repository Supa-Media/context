# App and console — share cards and the collab room

## A share card wears the app's palette, and leads with the workspace

Decided with the owner, 2026-09-21, from a screenshot of a short link
unfurling in iMessage and four words: "the app colors and designs have
changed so we should probably follow suit".

**The card was two design generations behind and nothing could have said so.**
It drew on `#050506` with a `#3B82F6` accent — the blue-black world and a
Tailwind default blue — while `apps/mobile/features/design/tokens.ts` had long
since replaced both with **Graphite and Paper**. That file's own header names
the reason it did: "a palette assembled from a framework's defaults looks like
every other application assembled from them". The card was still assembled
from them, so every link this product minted unfurled in a palette the product
itself no longer used anywhere. It had also kept Onest, which
`features/design/fonts.ts` stopped loading.

`apps/convex` cannot import from `apps/mobile`, so the values are restated in
`lib/cardArt.ts` — and **the restatement is compared against the token file in
`__tests__/cardArt.test.ts`**, which reads it as text and looks each colour up.
That is the guard the first drift did not have. Petrol is the only hue on the
card, which is the token file's rationing rule applied here: petrol means
"here, active, yours" and is never a status, and a card reports no status.

**One face, and the mono is drawn in it.** The chip and the domain line wanted
JetBrains Mono, which is a second binary and a second glyph-coverage surface
for two short Latin strings. `cardCoverage.ts` reads the cmap of whatever font
it is handed, so one bundled face is one question about tofu rather than two.

### The workspace leads and the domain is a footnote

`context.lc` sat in the position of most emphasis, which made every share look
like an advertisement for us rather than like somebody's note being handed to
somebody else. The lockup is now the handle.

**It is drawn only where the link's own address already carries it.** A short
link has told the crawler `@seyi` before it asked for anything; a token link is
`/s/<64 hex>` and says nothing about whose context it is, so a handle there
would be a new fact for everyone the link is ever forwarded to — and
`privacy-and-sharing.md` has a standing rule that link previews reveal nothing
about a context. A card cannot be recalled once a platform has copied it, so
this is decided in the direction that can be widened later. Claiming or
releasing a slug re-renders the card, because that is the moment the answer
changes.

### The chip is tied to the listing, not to the row

`NOTE`, `FOLDER` or `FORM`, from the share row and never from the note. The
folder case is narrowed by `drawnKind`: **a folder with nothing team-visible
inside it draws as a note, chip included.** The folder mark this chip replaced
already followed that rule — the mark and the listing appeared together or not
at all — and a `FOLDER` chip over an otherwise empty card would say "this is a
folder and there is nothing in it for you", permanently, to everyone the link
reached. That nearly shipped; `drawnKind` and its test are what stop it.

`FORM` is the one chip whose subtitle differs, and it has to: a collect link
takes answers from people with no account, so a card telling them to sign in
would contradict the page it points at.

### What a "simplification" would cost

Each has a test in `__tests__/cardArt.test.ts`, sabotaged to confirm it fails.

- Restating the palette without comparing it to the token file is how the card
  fell two generations behind in the first place.
- Tying the chip to the row rather than to the listing discloses an empty
  folder, in a picture that cannot be taken back.
- Supplying the handle for every share publishes the workspace on links whose
  address never did.
- Drawing the domain unconditionally puts `context.lc` on the card twice,
  which is what it did when this was written.

### One image, not two

An `og:image` is a single static PNG a crawler fetches once. There is no media
query and no theme signal, so the card cannot follow the reader's appearance
the way the app does — Paper exists in the product and cannot ship here, and on
a white message bubble a `#FFFDF9` card has no edges at all. Graphite holds on
both. The share *page* is HTML and is a different object; making it follow the
reader is open and unforeclosed.

### The static card's pipeline is a script now, because the old one was unrunnable

`og-card.source.html`'s comment carried a regeneration command — headless
Chrome plus ImageMagick — and neither is installed in this repository's own
environment. A command nobody can run is how a source file and the artefact
beside it drift into disagreeing, quietly. `infra/router/scripts/render-og-card.mjs`
uses what the repository already installs, and the first thing it caught was
itself: rendering against Google Fonts behind a TLS-proxying environment fails
with `ERR_CERT_AUTHORITY_INVALID`, the page falls back to the system sans, and
the screenshot **succeeds**. The face is injected from the repository's one
copy of Instrument Sans instead, and the script asserts `document.fonts.size`
rather than `document.fonts.check` — which answered `true` with zero faces
loaded, because it reports whether text can be rendered and a fallback can.

## The room binds to a document it agrees with, and a different note unbinds first

Found from three screenshots and one sentence — *"whatever I'm selecting on the
left is not the content that shows up in the middle"* — where the tab, the
breadcrumb, the path and the word count all named the note that had been
clicked and the text on the glass was a different note entirely.

**Two rules came out of it, and each one had already cost a note.**

### A different note is the `notePath` effect's, not the `value` effect's

`usePresence` builds the shared document for a note in the *parent's* effect,
and a child's effects run first — so the commit carrying the new note's `value`
still carries the previous note's `presence.shared`. `LiveEditor.web.tsx`'s
authoritative-value effect stands down while a document is bound, correctly and
for the reason its own comment gives, and the new note's text was landing in
that guard and being dropped. Nothing wrote it again. The editor was frozen on
the first note it had ever been given while everything around it moved.

So a change of `notePath` is now its own effect, and it takes the binding down
before it writes: while a binding is up, `YSyncPluginValue.update` relays every
document change into that room, so writing note B into an editor still bound to
note A's room would send B down A's wire as an edit of the note other people
are reading. It compares before it writes, because a rename changes the path
under a document that is not changing and a caret in the middle of a sentence
belongs where it is.

### A binding needs the same text on both sides, so an empty room is waited on

`yCollab` maps editor offsets straight onto `Y.Text` offsets and reconciles
nothing at construction. Two consequences, both silent:

- Binding an empty room to a document that already holds the note means the
  seed arrives as an insert at 0 of text the editor is already showing — the
  duplicated note `sharedDoc.ts` is written to prevent, arriving from the one
  direction it did not cover — and any keystroke before that lands at an offset
  the room does not have.
- `ySync` is one module-level `ViewPlugin`, and CodeMirror keeps a plugin's
  value across a reconfiguration that still contains that plugin. Swapping
  `yCollab(a)` for `yCollab(b)` in a single dispatch therefore leaves the *same*
  plugin in place, still holding the `Y.Text` it was built with: bound in name,
  relaying into a room nobody is in. Removing it and adding it back are two
  transactions for that reason.

A room that already holds the note is authoritative and is written in; a room
that holds nothing yet is waited on rather than bound, so the note stays on the
glass and `value` stays its authority until the seed or the replay gives the
two of them the same text.

### What a "simplification" would cost

Each has a test in `apps/mobile/__tests__/liveEditorNoteSwitch.test.ts`,
sabotaged to confirm the right one fails.

- Letting the `value` effect carry a note change again is the reported bug: the
  editor shows the note before the one that was clicked, indefinitely.
- Writing the new note in without unbinding first replaces the text of the note
  being left, in its room, for everybody in it.
- Swapping the binding in one dispatch is the freeze that hid this: every room
  after the first is bound in name only.
- Binding an empty room writes the note twice when the seed lands, or blanks it
  if the document is reconciled to a room that has nothing in it yet.

## Several rows are one operation, and a pick is what the keyboard acts on

⌘-click (ctrl-click off a Mac) and shift-click pick rows in the file tree, and
a right-click, a drag or a row chord on a picked row acts on the whole pick.
`selection.ts` holds the click rules, `useFileBrowser`'s `…Many` methods the
batches.

**A batch is one `run`, never a loop over the single-path methods.** Each
single call is its own `run`, and a newer `run` supersedes an older one: it
clears the older one's toast, skips its refresh and takes the busy flag. Five
moves in a row was one toast offering to undo the fifth. So a batch works
through its paths in order inside one `run`, says one sentence, and offers one
Undo that inverts every step last first. The first failure stops it: nothing
done is an ordinary failure, something done is a **notice** saying how far it
got and no Undo — `run` already reserves the notice for a half-failure, and an
Undo for the part that happened reads as an Undo of the whole. `bulkFileOps.test.ts`.

**With a pick up, a row chord acts on the pick or on nothing.** The open note
is still `selectedPath` underneath, but it is not what the tree draws selected
any more; ⌘⇧⌫ trashing it while three other rows sat highlighted would delete a
row nobody was looking at. So the pick is held by the console layout beside
`Shortcuts`, and the single-target chords (rename, duplicate, copy, cut) do
nothing while it is up. `rowCommands.test.ts`, "with several rows picked".

**The selection menu offers move, archive or restore, copy paths and trash —
not copy, cut or visibility.** The clipboard holds one path, so "Copy 3 items"
would paste one. Visibility has no batch write and no single Undo, so a "Share
3 items with the team" that stopped after the second would leave a privacy
change half made; that is the one item where half made is a disclosure, and it
waits for a server-side batch. `fileMenu.test.ts`.

A pick holds only rows on screen: collapsing a folder drops what was picked
inside it, and a folder with a picked note inside it moves as one path.
Moving into another context stays one item at a time — `moveToContext` has no
batch form and no Undo.

## No UI ships without a design audit first (2026-09-23)

The owner, on the first meeting-Resume UI: "SO ugly, never ship anything like
that without having a UI/UX subagent audit and design based on a principle of
simplicity, beauty, not making things feel clunky, and making things feel like
it naturally just fits there." That version was built straight from a feature
spec: one verb on five surfaces, a floating teal bar, a teal band in the note,
and the hero button four times. Every piece passed its tests, and nobody looked
at the surfaces together before they merged.

So any change that adds or changes user-facing UI gets a design pass before it
is built, and a second look at screenshots of the built result before it
merges. The pass audits against those four words, and in practice that means:

- **One place per verb**, where the thing it acts on already is. A second
  entry point needs a reason that the first one cannot serve.
- **Nothing drawn until it is reached for.** An offer that costs no pixels
  until somebody goes to use it never needs a dismiss.
- **No new styles.** Reuse the component the neighbours use, the way they use
  it. The accent means "here, active, yours" and is never a status; the white
  hero button is the landing page's.
- **Show, don't explain.** Copy about the plumbing (parts, files, paths) is a
  sign the UI is explaining a gap it could close.
- **Screenshots, both densities, both schemes**, shown to the owner. A surface
  that is not reachable in a browser gets a fixture (`features/e2e/`) so that
  it can be photographed; `scripts/capture-resume-shots.mjs` is the example.

What a "simplification" would cost: skipping the pass is how the Resume UI
shipped, and how it was rebuilt the same day.
