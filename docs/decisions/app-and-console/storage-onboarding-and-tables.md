# App and console — storage onboarding and tables

### Storage starts with ownership, then offers existing notes

The first storage decision has two peer paths: **Bring your own storage** and
**Context-managed Premium storage**. The first opens the S3-compatible and
Dropbox provider choices. The second names the 50 GB allowance and continues to
the existing Premium confirmation. Neither path is marked safer or recommended;
the choice is technical control versus convenience.

After either path connects, first-run asks **“Have an Obsidian vault or existing
Markdown notes?”** The same question appears in Storage settings for an existing
workspace. On Mac and web, the person chooses the folder and Context streams its
files directly into the connected storage at the same relative paths. Markdown,
folders and attachments therefore keep working together; a successful first-run
import replaces the layout question rather than putting PARA beside a structure
the person already has.

An import into storage that already has data starts with an explicit choice.
**Merge without replacing** keeps the vault's paths and skips every collision.
**Keep it in its own folder** puts the selected vault under
`Imports/<vault name>/`. Those two choices cannot replace an existing object.
The third choice, **Replace everything**, is deliberately destructive: it
removes every object in the bucket before uploading the selected folder.

Replacement has two gates. The screen names notes, attachments, access
settings, audit files and Context plumbing explicitly, says Context cannot undo
the operation, notes that provider-side object versioning may retain older
versions, and requires the owner to type the exact phrase `I understand` before
the folder picker appears. The server requires that same phrase when it creates
the job. A client that hides or bypasses the warning therefore still cannot
mint a replacement job.

The import is bounded, batched and create-only. Convex stores the total counts,
completed batch numbers, and a fingerprint of the local manifest. It never
stores file bytes or note bodies. The person must keep the tab open while bytes
upload because the source vault remains on their device. If the tab closes or a
request fails, they return, select the same vault, and resume after the last
completed batch. Stable path ordering keeps batch numbers consistent when the
browser enumerates the folder in a different order on the second selection.

Replacement adds a durable counting-and-deletion prefix to that same job. It
first counts every object, including dot-prefixed plumbing, then repeatedly
deletes the first bounded page. It never persists a continuation cursor while
mutating the listing, because several S3-compatible stores can skip keys when a
cursor outlives the page it described. Convex records only total and deleted
counts. If deletion succeeds and progress recording does not, retrying the
shrinking first page is safe; the final empty page reconciles the count. Upload
bytes are refused until the job says deletion is complete.

The last replacement batch idempotently creates a new all-private `privacy.md`
before the job may become complete. This happens server-side rather than in a
client follow-up, so closing the tab between the last object write and the
privacy repair cannot strand the replacement without an access map. The person
still has to keep the tab open while local bytes are crossing; after a failure
they reselect the same vault and resume the stored deletion or upload phase.

The client shows the completed file count and percentage. Server audit records
contain paths and counts only. After a fresh onboarding import, the existing
all-private repair path creates a valid `privacy.md` from the uploaded top-level
folders. A merge or folder Settings import never rewrites an established
workspace's access map. Replacement deletes that map with everything else and
creates a new private one from the replacement vault's folders.

Obsidian application state and Context plumbing do not come along:
`.obsidian/`, `.trash/`, `.git/`, `.context/`, `.audit/`, system metadata and a
source `privacy.md` are excluded client-side and refused again server-side.
This avoids uploading plugin credentials or replacing Context's access map.
Folder picking is Mac/web-only because native mobile pickers do not preserve a
vault's relative paths; mobile says where to continue instead of flattening the
vault.

The browser picker waits for the file input's own `change` or `cancel` event.
It must not infer cancellation from the window regaining focus: Chrome restores
focus before it has finished enumerating a directory, so a focus timer can win
the race and discard a valid selection. The regression test deliberately sends
focus first and the selected files later. The import screen also reflects that
intermediate state as “Reading the selected folder…” instead of leaving the
button unchanged.

The Settings flow is one staged card rather than a stack of policy boxes. It
keeps the merge choice visible, shows a folder-reading state, then names the
file count, size, destination, and one `Upload N files` action. The keep-tab-open
warning appears when there is actually a local selection to protect and remains
beside live progress; it is not the first thing somebody sees before choosing a
folder.

**"Create-only" is a claim about the bucket, not about the request, so the
capability decides which way it is enforced.** Every adapter here *sends*
`onlyIf: { absent: true }`; whether the bucket obeys is the question
`initialCapabilities()` answers `false` to until a probe says otherwise, because
"B2 and arbitrary S3-compatible endpoints do not reliably" support conditional
writes. Sending the precondition and trusting the reply on a binding that has
not proven it is how a write that should have been skipped comes back reported
as *created*, with the person's own file gone underneath — the "lost write with
no error" that comment calls the one failure mode a notes product cannot have,
arriving during onboarding over the vault they are importing. So
`importVaultFiles` reads `store.capabilities` exactly as `saveNote` and the
manifest writers do, and an unproven backend gets a read-then-create whose
residual window is one round trip. The check is `does not lose an existing file
on a backend whose conditional writes were never proven`, and it needs
`memoryS3`'s `ignoreIfMatch` to also ignore `If-None-Match` — the same feature,
so a stub that honoured one and not the other was answering for a backend that
could not be the one in doubt, and the create-only claim was only ever tested
where it holds for free.

### A connected account is one card, and its consequence is armed

The Google connections card was the ugliest surface in settings, and none of it
was accidental — each layer was reasonable on its own day.

**It was four boxes deep.** A `Card` held a `Row` per account, which held a
bordered block per service, which held the destination field; with the sync
schedule, four nested bordered surfaces before the one control. Three services
on two accounts is twelve nested boxes on a screen somebody opened to change
one path.

**Its right-hand column was permanently red.** `connectionActions` carried a
`danger` button and the standing sentence "Removes the whole account — Calendar
and Chat stop too", drawn once per account and never not on screen. So on a
two-account panel the most visually dominant thing was destructive text nobody
had asked to read — and the control armed anyway, meaning the warning was
displayed at all times *and* repeated between the presses.

**It said its own scope four times.** A title ("Google accounts"), a sub ("Each
Google account whose calendar this context reads"), a pill ("2 connected"), and
then every account row repeating "Email, Calendar, Chat connected". A reader on
the Calendar panel was told about Email and Chat four times.

Now: one card per account, the destination as a row that opens on Change, and
the consequence of Disconnect said **between the two presses** — which is where
every other irreversible control in this console says it (`useArming`, the same
shape as storage's Disconnect and a share's Revoke). The service list survives
as the single quiet line above that control, because a narrowed panel genuinely
has to say it: `GoogleActions` has no per-service call, so a reader who arrived
from the Calendar heading would otherwise have no way to know their mail stops
too.

Three smaller things went with it. The path is `mono`, which it always should
have been — a proportional face is what let a value scroll out of a field
narrower than itself without anybody noticing. The current sync interval was
`variant="white"` — the landing page's hero CTA — *and* disabled, so the
loudest element on the card was a fact nobody could act on; it is marked the way
`AppearancePanel` marks its current choice instead. And a reader with no
`saveDestination` is now offered no way *into* the editor rather than a disabled
Save button, which is this console's own absent-not-disabled rule finally
applied here.

**What a "simplification" would cost**: putting the destination back in an
always-open field returns three forms per account to a screen where nobody
edits three paths at once. Moving the consequence back beside the button makes
destructive copy permanent furniture again and leaves the arming saying nothing
new.

**The tests that fail if this is reversed**: `what Disconnect takes with it is
said between the presses, not beside the button` and the `the destination
editor` block in `apps/mobile/__tests__/googleConnectionsCard.test.ts`, plus
`a narrowed card offers no way into the editor without a saver` in
`apps/mobile/__tests__/communicationsPanels.test.ts`.

### Reading mode is the whole rule for a block that replaces its own source

> **Superseded for tables** by "A grid is edited in place, and the unit that
> reveals is the cell" below, which reverses exactly the paragraph this section
> ends on. It stands unchanged for the other two blocks, and the argument here
> is what the reversal had to answer.

Three things in a note are drawn as something other than the characters that
mean them: a `form` fence becomes a form, a GFM table becomes a grid, and an
`html-preview` fence becomes a diagram. All three are gated on **`state.readOnly`
and nothing else** — reading mode, `privacy.md`, a viewer below editor, an
encrypted envelope — rather than on a flag of their own.

That is not tidiness, it is the file's central rule arriving at its limit.
Everywhere else Live Preview serves "you cannot edit syntax you cannot see" by
**revealing markup when the caret enters it**: `## Heading` is a heading until
you click the line. A block widget cannot do that, and the two that came first
show why from opposite directions. Filling in a form field *is* putting a caret
somewhere, so a form that revealed on selection would turn back into a code
fence the instant anybody tried to use it. A table's cell is the thing the grid
replaced, so a grid that gave way on selection would flicker between two layouts
as somebody arrowed along a row.

A reader has no caret to reveal anything with, so the competition disappears:
**editing shows you the source, reading shows you the thing.** The source is one
press of the eye away, which is also the only place it can be fixed — which is
why a `form` block that will not parse draws a card naming the line rather than
a half-built form, and why a table the reader refuses falls back to the mono
face rather than to nothing.

The cost, stated: find-in-note searches the document, so a match inside a
replaced range is not visible while reading. The grid also cannot carry
`noteLinks`' click target, because that extension resolves a path against the
open note through a ref that does not reach a widget — so a `[[wiki]]` link in a
cell is drawn as its words in the link colour and is **not followable** until
you leave reading mode. Both are real, both are the price of the block widget,
and neither is worth a second reveal rule.

**What would reverse this** is making a grid editable in place, and that is a
different product: it needs a serializer from the drawn cells back to pipes,
which is exactly the round trip `livePreview.ts` exists to avoid — "the buffer
**is** the Markdown", and nothing here parses the document into another model
and writes it back.

*(That reversal happened, for tables and for tables only. The next section is
the answer to this paragraph — there is no serializer, because the cell you are
in shows its own characters.)*

### A grid is edited in place, and the unit that reveals is the cell

A table in a note being written was a paragraph of pipes for the whole of the
time anybody was working on it, and the section above says why: the grid was
gated on `state.readOnly`, so a table rendered only once you had stopped
editing. The complaint is the obvious one, and it came with the obvious
reference — Obsidian draws the table while you type in it.

So tables are now drawn in **both** modes, and what the eye takes away is not
the grid, it is the typing. A read-only note's cells are drawn and not
editable, which is `editability`'s own rule about a control that could only
ever fail.

**The reveal rule was right about the flicker and wrong about the unit.** The
old argument was that "a grid that gave way on selection would flicker between
two layouts as somebody arrowed along a row", and it would — if the unit that
reveals is the *table*. It is the **cell**: the one with focus shows its own
markdown and every other cell stays drawn, so `**bold**` is in the cell you are
in and **bold** is in the one beside it. That is this editor's central rule
about `## Heading`, applied one level down, and nothing flickers because
nothing around the caret redraws.

**And that is the whole answer to "it needs a serializer".** It does not. The
focused cell's text *is* the source, so writing it back is a change to the span
between two delimiters and nothing else in the file is read, let alone
rewritten. `tableEdit.ts` is where that promise is kept and it holds no model
of a table: every function takes a range of the document and the characters
somebody typed into that range. A hand-aligned table stays hand-aligned in
every cell except the one being edited — pinned by *a hand-aligned table keeps
its alignment in the cells nobody touched* in `apps/mobile/__tests__/tableEdit.test.ts`.

The three characters that cannot be in a cell as themselves are handled at the
keystroke rather than refused: a typed `|` is escaped (a keystroke that
silently splits the row into a new column is the table breaking under the
person editing it), a pasted newline becomes the `<br>` the cell reader already
draws, and the outer spaces are padding rather than content.

**The structural edits exist because the source became unreachable.** Once a
table is always drawn, the pipes are no longer somewhere a person can go and
fix — there is no source mode in this editor, only reading and writing. A grid
that could not gain or lose a row would be a grid you had to leave the app to
repair. So an editable grid carries four controls, pinned to its own frame and
revealed on hover or focus: add a row, add a column, delete a row, delete a
column. The two deletions stay **disabled until a cell has been focused**,
because "delete row" with no row named has to guess and the guess is a row of
somebody's note. Tab past the last cell and Enter on the last row add one too,
which is how a table gets longer without anybody reaching for a control.

**What this costs, stated rather than discovered:**

- **CodeMirror's caret is not in the cell.** Focus is in a `contenteditable`
  element of the widget's, so `view.hasFocus` is false while somebody is typing
  in a table — which is deliberate, because it is what stops CodeMirror drawing
  its own selection over the top. Escape hands the note back with the caret
  after the table.

  This one is **closed rather than stated** now, and the way it was closed is
  the reusable part. `toggleWrap` asks `toggleMarkerInCell` first, so Bold from
  the keymap, from the phone's accessory bar and from the right-click menu all
  reach the cell that has the caret; the decision is `planToggle`'s either way,
  so the CommonMark run rule that makes ⌘B and ⌘I compose is the same one a
  paragraph gets. `planToggle` and the marker pairs moved to `markerToggle.ts`
  to make that possible without a cycle — `markdownFormat.ts` imports
  `livePreview.ts`, so the shared half could not stay where it was.

  The **chords** need one more thing, and a browser is what said so: a unit
  test that calls `toggleWrap` directly passes while ⌘B in a cell does nothing,
  because `ignoreEvent` tells CodeMirror every event inside the widget is the
  widget's and the editor's keymap therefore never sees a keystroke made in a
  cell. That is right for Tab and Enter and leaves the chords with nobody to
  answer them, so the cell answers them itself from the same three-row table.
- **A column GFM invented for a short row is drawn and not editable.** There
  are no characters in the file for it, so there is nothing for a keystroke to
  replace, and a cell that wrote to a range it invented would put its text in
  the row's last real column.
- **A redraw skips the focused cell**, so a change arriving from elsewhere —
  a sync, an undo — does not appear in the cell being typed in until it is left.
  The alternative is the document's version of the text landing under the caret
  mid-word.

**Three things asked "where is the caret?" and answered from the document**,
which is the class of defect this change created and the reason they are listed
together rather than as three fixes:

- The table picker's own command put the caret in the new grid's first cell and
  `LiveEditor.web.tsx` called `view.focus()` immediately after, taking it back
  out. `insertTable` now reports whether a cell took the caret. **Only the
  WebKit job saw it** — jsdom has no menu, so the unit test focused the cell
  and nothing took it away.
- Both halves reported focus from `contentDOM`, which does not have it while a
  cell does, so a tap on a cell read as a blur. On the phone the accessory bar
  is the only way out of the keyboard, so that raised the keyboard and removed
  the way back. `focus`/`blur` do not bubble and `focusin`/`focusout` do, so the
  pair moved to the editor's root on both halves, with a `focusout` that lands
  inside the editor saying nothing.
- `caretBox` measured `state.selection.main.head`, which is not where somebody
  typing in a cell is looking, so the keyboard-avoidance scroll would have gone
  to whichever line the selection was left on. The focused element answers for
  itself when it is inside the editor and is not `contentDOM`.

The general rule, for the next widget that takes a caret: **a widget's
`contenteditable` is a caret in the note and not a caret in the document**, and
anything that reads the selection to find the person has to say which of the two
it means.

**And one table is still not drawn: the one being typed.** `| - | - |` is a
valid delimiter row, so a table parses *in the middle of* typing the dashes.
The grid went up over the two lines being written, the caret was left at the
end of a line that was no longer on screen, and the rest of the row went in
where nobody could see it — measured in Chromium, `| --- | --- |` finished as
`-- |` under a two-column grid, and the body rows after it never joined the
table at all.

So `writingTable` holds the one table that gives way, and it is **identified
rather than inferred from where the caret is**: position cannot answer this,
because a caret at the end of the delimiter row and a caret parked there by
Escape are the same number and want opposite answers. A *document change* with
the caret in a table marks that table as being written; a selection that leaves
it puts it back; and the two gestures that hand a table over rather than leave
it — Escape out of a cell, and a cell taking focus — say so with an effect.
Arrowing about inside the source keeps it revealed, which is the courtesy every
other construct here extends to the thing being edited.

Two details are asymmetric on purpose, and each was found by a test rather than
reasoned out. The change has to **touch** the table, or an edit elsewhere would
reveal a table whose first character the caret happens to rest on —
`openingCaret` parks at the first line of the writing, which on plenty of notes
is a table. And the caret has to be **past** that first character: arriving from
above is being beside a table, while the end of its last line is where the
keystroke that made it one leaves you.

This does not reintroduce the flicker the old rule feared. A caret in a cell is
not a caret in the document, so a grid somebody is working in is never the one
being written, and `atomicRanges` means the document's caret cannot walk into a
drawn table — it gets inside one only by writing it.

**The visual half was also only visible in a browser**, which is the third
finding of #733 arriving on its own: the control bar was pinned outside the
grid so an editable table would occupy exactly what a reader's does, and in the
running app it was drawn across the last line of the paragraph above and then
cut in half by the grid's own scroller — `overflow-x: auto` clips the other
axis too. On a narrow table it was worse: an absolutely positioned box cannot
be wider than the box it is positioned in, so a two-column table of single
characters folded every label into its own column and drew "+ r o w" on top of
"+ c o l". The grid reserves the space now and keeps a floor under the frame,
and `apps/mobile/e2e/webkit/tables.spec.ts` measures both — the bar inside the
grid's own box and above the table, and four buttons on one row at four
different lefts.

That spec opens `2-areas/public-worship/org-chart.md`, which carries a table
for the fixture reason #733 states. It is **not** in `weekly-review.md`, where
the constructs usually go: `callouts.spec.ts` types at the end of that note and
arrows back up into what it wrote, and a drawn table is an atomic range the
caret steps over.

**What would reverse this** is a cell that wrote back what it *drew* rather
than what it holds: that is the serializer, and the first thing it would do is
replace `**bold**` with `bold` the moment anybody put a caret in the cell. The
tests that fail if it is: *the source is what is written back, so the markup
survives an edit* and *the element survives the keystroke that changed the
document* in `apps/mobile/__tests__/tableEditing.test.ts`, the second of which
is the reason the widget patches its own DOM instead of letting CodeMirror
rebuild it — every keystroke is a document change, and a rebuilt widget loses
the caret on every letter.

### A control on a table belongs to the row or the column it acts on

The first editable grid carried a bar of four buttons above it — add row, add
column, delete row, delete column — acting on **the last cell that had the
caret**. The report it earned was *"deleting a row is not really possible"*,
and driving it in a browser found two failures rather than one.

The obvious gesture, hover the table and press *delete row*, does nothing at
all: the button is disabled until a cell has been focused, and a disabled
button explains nothing. And once a cell *had* been focused, the button stayed
armed after the caret left the table entirely — so a press deleted a row chosen
by something the person had stopped thinking about three clicks ago. Measured:
a click in a paragraph above the table, then a press, took a row out.

Both are the same mistake, and it is worth naming because it is not about
tables: **a destructive control whose target is not on screen.** Arming it on
remembered state made it worse rather than safer, because the remembered state
outlived every cue that it existed.

So every control hangs off the thing it acts on. A handle in a gutter beside a
row opens that row's menu and tints that row while it is open; a handle in the
strip above a column does the same for the column; the corner handle is the
table's. The handles are **cells of the table** rather than boxes positioned
over it, so each one is laid out by the table itself beside its own row at
whatever width that column came out — the alternative is measuring a grid that
is rebuilt on every keystroke. A reader's table has no gutter and no strip.

Two things stay plain buttons, because a menu could not make them clearer:
`+ row` and `+ col` append at the end.

**The menus are also where the verbs nobody had live.** A table needs more than
four of them, and the set is what somebody retyping a table by hand is doing:
insert above/below and left/right (the append could reach neither end), move a
row or a column (the alternative is retyping it), set a column's alignment —
which GFM keeps in the delimiter row, the one row the grid never draws, so
before this there was **no way to set it from the app at all** — and delete the
table, which nothing could do, because `atomicRanges` keeps the caret out of a
drawn one.

**"Edit as text" is the escape hatch and is the reason the rest can stay
small.** It hands one table back as its own pipes, which is the state
`writingTable` already models for a table being typed, so leaving is the same
gesture. Anything the menus have no verb for — a stray escape, a row the parser
refuses, a wholesale rewrite — is one press away instead of a reason to open
another app.

**Undo is what makes a destructive menu safe, and it did not work.**
`ignoreEvent` keeps every keystroke made inside the widget away from the
editor's keymap, so ⌘Z in a cell reached the browser's own contenteditable
history, which knows nothing about the document: it would put characters back
into the element while the file kept the change. The cell answers ⌘Z and ⌘⇧Z
itself now, letting go of focus first so the redraw is free to draw the
document that came back. Shift-Enter is answered there too, as the `<br>` that
is the only way a Markdown cell holds two lines.

**What a browser caught that 7,600 checks did not:** a menu drawn on the
document body is outside the element the `--lp-*` palette is declared on, and
an unknown custom property invalidates its whole declaration rather than
falling back — so the menu had no background and the note's text showed
through it. The same defect this log already records as *white text on a white
ground*, reached from the other direction. The palette now travels to the
element, read off the handle. It is on the body deliberately: inside the grid
it would be clipped by the same scroller that cut the first chrome in half.

**What would reverse this** is any control that acts on a row it did not name.
The tests are *the handle of the second row takes out the second row* — pinned
separately, because a handle that forgot its index passed every other case in
the file, which presses row one — *and it is that row, not the one somebody
last had the caret in*, and *the menu is drawn in the note's own palette,
outside the note* in `apps/mobile/e2e/webkit/tables.spec.ts`.

