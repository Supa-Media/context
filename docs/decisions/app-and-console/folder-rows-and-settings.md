# App and console — folder rows and settings

## A folder row says what differs, so `0-inbox` gets no count

**Decided 2026-09-18 by the owner, closing a gap the design canvas opened.**

`Phone-Browse.dc.html` draws a folder listing with a `3` beside `0-inbox`, in
accent, in the slot where the row's other marks go. It was recorded as an
outstanding difference between the app and the canvas, twice, and escalated as
"the app has no cheap source for the number". That framing was the mistake: the
question was never where to get it.

The owner's answer is that **that is not what the inbox there means**. It is a
folder you file out of, not a queue with a depth, and a number beside it turns
"you have not filed today" into an unread badge — a count that demands to be
driven to zero, on a surface whose entire job is to be a calm list of folders.
Nothing else in the listing counts, and the one folder that gets a number would
be the loudest thing on the screen.

**And it would be a number in the wrong slot.** The trailing position on a
folder row is where `FolderRow` draws the exception mark — the pip that says
*this row's visibility differs from its folder's*. The tree's rule, stated in
that file, is that a listing marks **only exceptions**: a `team` on every row of
a team folder is the default drawn once per file, which buries the one row that
differs from it. A count is not an exception about anything; it would be the
first mark in that slot that is not making the listing's one claim, and the pip
beside it would lose the meaning it has by being the only thing there.

**What a "simplification" of this would cost.** The tempting one is the reverse:
draw the count because the canvas draws it, and source it from the listing that
is already loaded — which is genuinely cheap, and is why this stayed open as a
data question rather than being closed as a design one. The cost is a badge
nobody asked for on the first screen of the phone, and a trailing slot that says
two unrelated things.

**The test that fails if it is reversed.** There is none, and that is
deliberate: this is a decision not to draw something, and a guard against
drawing it would be a test asserting the absence of a feature nobody has.
`FolderView.tsx`'s own comment on the exception mark is what a future reader
hits first, and it now says the slot is for exceptions and names this.
## The workspaces come back as a row at the foot of the tree, not as a column

**Superseded on 2026-09-26** by [the account button at the foot of the
tree](#one-account-button-at-the-bottom-left-replaces-the-chip-and-the-row). The
reasoning below is kept because the alternatives it weighed are still the
alternatives.

The owner, looking at the console:

> Right now, it's not super visible — all the workspaces that someone's in,
> you got to click on it and drop down… I just want to explore some different
> UX/UI designs for that, because we want people to be able to switch more
> quickly.

The switcher menu is two presses, and the worse half of that is not the count:
it is **invisible at rest**. Nothing on the screen says a second workspace
exists, so nothing reminds anybody that it does. An account with four contexts
looked exactly like an account with one.

Five directions were drawn to scale and the owner picked one: **the context you
are in, spelled out, and the ones you were in last beside it, along the foot of
the file tree**. `features/console/foot.ts` is the rule and
`ContextFootRow.tsx` is the drawing.

### Why this one, and what the other four cost

- **A dock of full-width rows** at the foot of the same panel. Same zero cost in
  width, reads at a glance, and runs out at five or six workspaces — at which
  point it is a scrolling list inside a panel that already has one.
- **A pinned pill strip at the top of the panel** — the phone's `ContextStrip`
  on a second surface, which is the cheapest thing to build and the worst thing
  to use: 260 points fits about two pills, so the third workspace is behind a
  horizontal scroll, and a scroll gesture on a pointer is the most expensive way
  to reach something that was supposed to be one click away.
- **A 52pt icon gutter**, Slack's answer. It works, it scales to a dozen, and it
  is a column — which is the thing "The rail folds into the switcher, and the
  column it occupied goes to the note" spent 216 points buying back. 52 is less
  than 216 and it is the same trade in the same direction.
- **Tabs in the title bar**. Fastest to read, and it borrows a meaning it does
  not have: a tab is an open document you can close, a workspace is neither, and
  the title bar already draws note tabs two inches away.

### What the row costs, and where it is paid

**The panel is resizable, so the row is a function of its width.** The owner's
second and third instructions are the specification:

> when people extend it, we should be able to accommodate more space and maybe
> even show some of the workspace name if we have enough space

> if someone only has two workspaces and they're able to comfortably fit on that
> bottom panel without it being too crowded, then why not?

So `footPlan` takes the measured width and the real names and decides between
two shapes: **named pills** when every name on the row is whole, **marks** when
they are not. Nothing is ellipsised, which is `ContextStrip`'s rule — "two
contexts that look identical, on the one control whose entire job is telling
them apart" — with one stated exception: in the marks shape the *current*
context's label may shrink, because it is the third copy of that name on the
screen (the breadcrumb and the title bar's chip are the other two) and
budgeting it whole made the entire row disappear at the 200pt floor.

**Three recents, whatever the width.** Extra width buys names, not a fourth
workspace. A row that grew towards a dozen marks is the rail coming back at the
bottom of the panel, and everything beyond the third is behind the chevron —
which is `SwitcherMenu` itself, mounted with `trigger="chevron"` rather than
reimplemented, so the claim offer, "New workspace" and Leave keep their single
set of conditions.

**The title bar's chip stays.** It is redundant on Browse and it is not
redundant anywhere else: the explorer column is only rendered while browsing, so
demoting the chip to a label would leave Map, Connections, Search and Settings
with no switcher, no Settings row and no sign-out at a pointer density. Removing
it is a separate change that has to give those panes somewhere else to put it.

**No ⌘1–⌘9.** The obvious keyboard half of this row is already spent:
`keymap.ts` gives those nine chords to the note tabs, and `keymap.test.ts`
allows a command exactly one chord. Inventing ⌃1–9 for workspaces would be a
second digit row meaning a second thing, which is how a keyboard layout stops
being learnable. Left undone rather than done badly.

**What a simplification costs.** Dropping the width measurement and always
drawing marks is the tempting one, and it takes the owner's actual request back
out: the two-workspace account that fits comfortably is exactly the case the
names were asked for. Dropping the shape rule the other way — always names,
ellipsised to fit — is the defect `ContextStrip` already argued.

**The tests that fail if it is reversed.** `contextFootRow.test.ts`: "no row
where there is nowhere to go" (one workspace draws no band), "most recently
visited first, and never alphabetical", "the pinned context is held last", "three
at most, whatever the width" (asserted as the literal 3, because a test that
reads `RECENT_SLOTS` agrees with whatever `RECENT_SLOTS` becomes), "two short
workspaces are named at the resting width", "dragging the panel open buys the
names", "the floor still holds all three, however long the current name", "what
is planned fits the room it was planned for, at every width" — the sweep, which
is the one that catches a character-width estimate drifting narrow — and "every
workspace has a name a screen reader can read", which is the rule that killed an
icon-only rail once already.

## One account button at the bottom left replaces the chip and the row

The owner, on 2026-09-26, pointing at Discord:

> instead of the modal opening at the top and being able to switch workspaces
> we should mimic more traditional UIs like discord where we click on our
> name/icon at the bottom left and it opens up a modal … this would be
> replacing the panel to switch workspaces and setting at the top left and we
> can also remove the quick switch workspace icons at the right side and the
> arrow.

So a pointer layout has **one** door now: the account button at the foot of the
file tree, carrying *you* (your avatar and name) with the workspace you are in
on a second line. It opens a card that rises from it: who you are, your
workspaces (each with its mark, the current one ticked, yours marked "yours",
a dot on any that moved), New workspace or "Claim your @name", Meetings and
Settings, then Leave and Sign out. The title bar's chip and `ContextFootRow`'s
recent marks and chevron are gone.

- **The list did not change, only its container.** `SwitcherMenu.tsx` still
  builds every row from `railGroup` with the same conditions, so the reachability
  claims (`routeReachability.test.ts`) still point at that file.
  `AccountCard.tsx` draws it and decides nothing.
- **The panes with no tree are paid for.** The previous section kept the chip
  because Map, Connections, Search and Settings have no explorer column. Now
  `AppFrame` draws the same menu behind an avatar at the leading end of the
  status bar whenever the tree is not a column: folded away, peeking, or absent.
  `appFrameRender/accountFallback.test.ts` holds both halves.
- **Activity elsewhere is still visible at rest**, which was the foot row's
  reason to exist: a dot on your avatar when another workspace moved, and on
  that workspace's mark in the card, spoken as "which has changed".
- **What it costs.** Switching is two presses again, and the recents are no
  longer on screen by name. The owner chose that for a single, familiar place to
  look. A phone is unchanged: `NavBand`'s strip and the top-row account menu.

**The tests that fail if it is reversed.** `accountCard.test.ts` (the button
carries you, the card's order, the checked workspace, the activity dot, and
`cardPlacement` keeping the card inside the window),
`appFrameRender/accountFallback.test.ts`, and `fixtureConsoleDensity.test.ts`
("never draws two switchers at once").

### "Move to…" is one dialog, and the other context is a destination rather than a mode

A person who owns two contexts thinks "this belongs in @work", not "this belongs
in a different tenancy". So the destination picker gained a row of contexts
above its folder list, rather than a second command beside `Move to…`. Where
there is nowhere else to send anything — one context, or somebody who is only an
editor of this one — the row is **absent**, not a single disabled option: the
same rule the rest of this console follows, argued in the header of `menu.ts`.

Three things about that dialog are decisions rather than mechanics.

**The list of contexts is the client-side gate, and it is gated on ownership of
the context being left.** `useFileBrowser` empties it unless `isOwner`, because
moving something *out* removes it from everybody who could read it there — the
server's own rule in `functions/contextMoves.ts`. The console never offers a
destination whose press would be refused, and it never re-derives the rule from
anything else.

**Choosing another context asks it for its folders, once.** A console only ever
holds the tree of the context it is standing in, and walking another one a
`listFiles` at a time would be one bucket credential opened per folder. One
`folderPaths` action walks it inside the single call that already has the store
open, bounded, and says so when it hit the ceiling rather than presenting a
floor as a total — #25's shape. A folder chosen in one context is dropped when
the person switches to another, because two contexts can both have `work/` and a
stale selection is not an invalid press that fails, it is a valid press that
lands somewhere nobody chose.

**It is the one file operation that reports itself in a sentence.** Everything
else in this console finishes inside the press and reports itself by the tree
changing while somebody watches. A cross-context move can still be running
minutes later, in a scheduled action, with nothing on this device involved — so
it gets a line in the notice band that says what is happening, says that closing
the console does not stop it, and settles into something a person can act on: a
count, a list of what stayed behind and why, or a failure with "Finish the move"
rather than "Try again" — because everything already carried stays carried, and
resuming is not a re-run. A finished move is dismissible and a running one is
not, because a Dismiss that would be ignored is worse than no Dismiss.

**What a "simplification" of this would cost.** A second top-level command
splits one question into two and makes the cross-context case feel like a
different product. Drawing the context row from `canEdit` offers an editor a
control that is always refused. Keeping the chosen folder across a context
switch files something into the wrong context silently. Reporting a move only as
a toast loses the outcome for every move longer than eight seconds, which is all
the ones that needed reporting. `apps/mobile/__tests__/contextMoveBrowser.test.ts`,
`contextMoveNotice.test.ts`, and the "move dialog's other contexts" block in
`explorerActionGuards.test.ts` fail.
### Settings is seven rows, and a row has to earn its place

Twenty rows under four headings, each holding one word. Sayo, looking at it on
a call on 2026-09-18: *"I'm looking at the settings page right now. I'm
overwhelmed, bro."* That is the whole brief, and the rest of this entry is what
was done with it and what a reversal would cost.

**A row is a navigation, and a navigation is a question the reader has to
answer before they can ask theirs.** Twenty of them cannot be scanned, only
read, so the list was demanding a decision — *which of these twenty is my
question in?* — from somebody who had arrived with exactly one. The four group
headings were the first attempt at that problem and they made it worse: 10.5pt
in the faintest grey on the screen, carrying the whole of the structure.

Seven rows now, in the order the questions get asked:

    Profile · Workspace · Storage · Integrations · Meetings · Premium ·
    Sharing & Access

plus **Invitations**, which is present only while an invitation is pending.

**Domain** joined on 2026-09-24, after Sharing & Access. It earns its row by
answering a question none of the others answer: what address people type to
reach the workspace's published links. It can't sit under Sharing & Access,
whose first sentence is "Nothing here is public", and a domain is the most
public thing in the product. It isn't Premium either, because Premium is about
paying. See [custom domains](../privacy-and-sharing/custom-domains.md).
The same day the owner renamed the row **Website** (key `website`), because
the page is about to hold the website folder as well as its address. "domain"
stays a search keyword, and an old `?settings=domain` link still opens the page
through `RENAMED_SETTINGS_SECTIONS`. Test: "the Domain page renamed Website" in
`settingsSections.test.ts`.

**The four rules the collapse followed.**

1. **A merge is only worth it where the rows answered one question.** People,
   Groups, Shared links and Privacy all answered "who can see this", so they
   are four blocks of Sharing & Access. AI apps, Email, Calendar and Chats all
   answered "what is plugged in", so they are Integrations. Meetings stayed a
   row of its own because it is the one capture surface people open on purpose
   rather than configure once — the owner asked for it by name on the same
   call.
2. **Nothing is deleted with its row.** "Your devices" lost its row and its
   Revoke button became a card at the foot of Profile: a machine grant can
   capture into private notes, and this app is the only client that can cut one
   off. `CLAUDE.md` — never weaken revocability — is the rule, and the sections
   test is what fails if a later edit takes the card out too. Search is a block
   on Storage, Advanced a block on Workspace, Overview the *head* of Workspace.
3. **The keywords move with the content, always.** `matchSettingsSections`
   requires every typed word to match something, so a haystack that keeps a
   word for a row that no longer exists returns a section that cannot answer —
   worse than no match at all. "dark mode" reaches Profile, "rebuild index"
   reaches Storage, "who can see it" reaches Sharing & Access. That last one is
   spelled out as a whole sentence because it used to be the *group heading*,
   which the matcher searched alongside the keywords.
4. **Every retired `?settings=` value aliases rather than failing closed.**
   Twelve of them, in `RENAMED_SETTINGS_SECTIONS` — never in the catalogue, so
   they appear in no list and in no search result, which is what keeps an alias
   from being a second name for a section.

**What a row still costs, and the two things that removed one.** Appearance was
a Light/Dark/Follow-device picker with a stored choice behind it, a
module-level store to keep the panel and the provider agreeing, a synchronous
peek on web, an async read on native, and the launch image held up until that
read landed — all so one pinned value could arrive before the first frame.
Nobody asked to pin the app against their own system setting. The picker went
and the machinery went with it, because a stored value no surface can change is
a setting somebody is locked into. "Sign out & delete" was a row for two
buttons somebody presses once or never, and pairing them put the control that
ends a *session* on the only screen that can end an *account*.

**What a simplification of this costs.** The tempting one is to keep merging:
Meetings into Integrations, Premium into Workspace, Invitations into a
permanent row. Each takes back a distinction somebody on that call named —
meetings is a surface, not a configuration; Premium is about the account
paying; a row that says "None" on every load is a badge people learn to skip.
The other tempting one is to bring a heading back the first time a page feels
long: a heading over one row repeats its name, and four of them are what made
twenty rows unreadable.

**The tests that fail if it is reversed.** `settingsSections.test.ts`: "seven
rows, and one of them only when it has something to say" (the literal list),
"the list reads in the order somebody asks the questions", "one question, one
row: sharing answers all four of the old ones", "appearance is a sentence on
Profile, not a section of its own", "signing out is a control on Profile, not a
row of its own", "invitations is a row only while one is waiting", "the
machines are reachable from Profile, because the row went and the revoke did
not", and "deleting a workspace and deleting an account are not the same
search" — which is asserted by exact equality, so a keyword edit that merges
those two destinations fails loudly. `consoleNav.test.ts` holds the aliases.
`settingsOverlayRender.test.ts` sweeps every section for exactly one
`role="heading"`, which is what stops a merged panel from growing a second one.

### A pasted image is a width in the note and a file in the bucket, and nothing else

**Built, and this section was rewritten when it was.** It began as a design
recorded ahead of the work, with the tests it named still to be written. They
exist now, and one part of the design did not survive contact: alignment, below,
is a reversal of what the first version ruled out. What it got right is the part
that decided everything else — what a Markdown file can carry honestly.

**Pasting is two writes, in this order: the object, then the line.** `⌘V` in a
note writes the image into the bucket and then writes one embed line at the
cursor. A failed note write therefore leaves an unreferenced object —
invisible, recoverable, offered by name to its owner and never swept silently —
while the reverse order leaves a line pointing at nothing, which is a note that
reads as broken to every client at once. The line is drawn immediately, before
the upload completes, because the object's name is known before the bytes move
(below), so the optimistic line is the final one rather than a guess.

**The pointer decides between the two verbs, and a resize needs no click at
all.** Press and release on an image without moving and it is *selected* — ring,
corner handles, toolbar. Press and travel more than four pixels and you are
*moving* it, with the insertion caret showing where the line will land. One
target, two gestures, told apart by what the hand does: it is what Notion and
Craft do, and it is why the separate drag grip is gone — a 26px square with six
dots in it was a second thing to find for a gesture the picture itself can
carry. The side handles are on every writable image and appear under the
pointer, so the commonest edit is one drag rather than a click and a drag; the
cursor says the rest (`grab` over the picture, `grabbing` while it moves,
`ew-resize` over a handle). Putting the image down is the caret going anywhere
else — one definition of "the cursor is elsewhere", which this editor already
had — and the image's own toolbar carries no selection, so it stays picked
under the hand using it.

**A drawn thing that nothing redraws is not drawn at all.** Clicking an image
did nothing for a day, and the effect was landing correctly the whole time:
`livePreview`'s decoration field only recomputes when the document, the
selection, `readOnly`, the tree or the focus changed, and an image being picked
is none of those, so the field held the pick and the view kept the old
decorations. The gate now counts a fifth input. `imageInteraction.test.ts`
exists because no unit test could have caught it — both halves were right on
their own — so every assertion in it is made against a mounted `EditorView` and
its DOM.

**An image does not reveal its markup, which is this editor's one exception.**
Everywhere else in `livePreview.ts` the line the selection is in shows its
syntax, because you cannot edit syntax you cannot see. An image is where that
stops being true: the markup is a filename nobody types by hand, and clicking a
picture to have it turn into `![[paste-971e….png]]` was reported as "really
weird" the day it shipped — which it is. What replaces it is a **toolbar on the
selected image**: width chips, the three alignments as drawn icons, alt text,
Replace and Remove, plus corner handles and a grip. Every edit the line can
carry is a control on the picture, so nothing is lost by never showing the text.
The line is still ordinary text to everything else — a selection deletes it,
undo undoes it, another editor shows the embed — and `atomicRanges` keeps the
caret from walking into a row it cannot see. The selection lives in a
`StateField` rather than in the widget, because a widget is rebuilt on every
transaction and a selection kept inside one would be lost by the first resize it
was used for.

**The paste reads `DataTransfer.files`, and `items` only when that is empty.**
Reading both and de-duplicating by identity looks obviously right and is wrong:
`getAsFile()` mints a new `File` object on every call, so a browser that fills
both lists — Chrome, for one — handed back the same screenshot twice, it was
uploaded twice, and the note got two embeds of one image. Reported as "images
paste twice" within a day.

**The caret lands on the line *below* the image, and that is not a detail.**
The first version left it after the embed — on the image's own line — and the
reveal rule then did exactly what it exists to do: the line the selection is in
shows its markup. So a paste ended with `![[paste-….png]]` on screen, drawn as a
link, and the picture appeared only once somebody clicked elsewhere. Reported
within a day of shipping, with a screenshot of a link. A blank line under the
embed is written when there is not one already, which is where somebody would
keep typing anyway.

**The width goes in the pipe, and that is the load-bearing choice.**
`![[attachments/2026/09/paste-4b2c9f1a.png|480]]`, Obsidian's own grammar, which
[`links.ts`](../../../packages/shared/src/links.ts) and `apps/mcp/src/links.js`
already parse — `embed: true`, the target spanned so a rewrite replaces only
the path. An `<img src="…" width="480">` would render in more places and is
still the wrong answer: the link engine cannot see an HTML attribute, so the
first time somebody moves the note the image is gone, and `linkParity.test.ts`
has nothing to say about it. The rule is that anything a note points at must be
written in the grammar the rename engine speaks. A strict CommonMark renderer
shows a wikilink embed as text; that is visible, reversible degradation next to
a file that is right there, and it is the same trade the `html-preview` fence
takes. Which of the three link styles is written follows what the note already
uses — a vault on `![alt|480](path)` keeps getting that — because non-negotiable
#2 says user-authored keys and conventions are not ours to rewrite.

**Several embeds on one line are a row, and that is the whole of side by side.**
Not a convention of ours: an image is an inline node in CommonMark and in
Obsidian, so `![[a.png|320]] ![[b.png|320]]` is two images beside each other in
those readers as well as in this one. A row is therefore a *line*, dragging an
image beside another is one line edit, and there is no gallery syntax to invent,
parse or explain. The same fact settles moving: `⌥↑`/`⌥↓` already move a line, so
an image inherits that and gets no verb of its own. A line that is *nothing but*
embeds is a row; an image in the middle of a sentence stays part of the sentence,
because resizing that by dragging would reflow somebody's paragraph.

**Alignment is a directive comment, which reverses this section's first
version.** That version ruled it out, on the grounds that "nothing in Markdown
carries centred". The second half of that is still true and the conclusion was
too strong: an **HTML comment** is carried by every Markdown file and rendered by
no Markdown renderer, so `![[a.png|320]] <!-- context: align=center -->` is
centred here, uncentred in Obsidian, and *never visible junk* anywhere. It is
still in the file, which is the line this holds — metadata we understand goes in
the Markdown, degrading to invisible, and never into a sidecar the Markdown does
not contain. `left` writes no directive at all, because the absence of one is
what a file written by anything else looks like and those two must not be
different states; an unknown key inside a directive survives an alignment
change, so an older console cannot silently drop what a newer one wrote.

**The bytes go in the opaque store, and this reverses what shipped first.**
The first version put pastes in a visible `attachments/<YYYY>/<MM>/` folder,
argued from Obsidian: that app skips dot-folders, so an embed pointing into
`.context/` draws there as a broken link. The owner reversed it the day it
landed, and the reasons are better than the one it replaced — one image store
rather than two, nothing new in the file tree, the listing stays the customer's
own folders, and `IMAGE_PREFIX` is the prefix `read_image` already serves, so an
agent can fetch an image somebody pasted. A visible folder could not have
offered that without widening `imageRefFor`, which is a security-critical
function.

So a pasted image is `paste-<hash>.<ext>` under `IMAGE_PREFIX`, written through
the `writeImage` that was already there, and the embed names the leaf —
`![[paste-4b2c9f1a.png]]` — which is also what a person typing one by hand in
another app would write. **What it costs is stated rather than hidden**: that
embed does not resolve in Obsidian, because the bytes are in a folder Obsidian
does not look in. Export is unaffected — `.context/` leaves with everything else
— and a resolver on the Obsidian side, or a visible mirror of the store, is the
change to make if that becomes the thing people trip over.

**Reading one back is gated on the reference, which is the gateway's own rule.**
An image has no row in `privacy.md` and cannot have one — non-negotiable #5 keeps
`Scope` two-valued and about notes — so borrowed visibility is the only honest
model. `readNoteImage` asks whether there is a note *this caller can see* that
names this file, through the same `read` operation the editor uses, so `canSee`
answers once, where it already answers. A visible folder is one whose keys a
member can guess; this is what refuses the guess. Writing needs `editor`, because
a paste is not a read.

**The number is a cap, not a demand.** `|480` means "up to 480px", clamped to
the reading measure, which is what makes one note correct on a 390pt phone and
a wide window without a second number or a per-device override. Percentages are
not available (Obsidian has no percentage), so the four chips are fractions of
the measure — a quarter, a half, three quarters, Full — and what they write is
the px that comes out, identical from every surface, so a width means the same
thing wherever it was set. The drag snaps to those quarters with `⌥` to ignore
snapping, and aspect is locked because height is never written down: there is
nowhere honest to keep it.

**A resize is an ordinary edit, and takes #701's machinery unchanged.** It is a
one-line edit op carrying `expectedEtag`, rebased only by `rebaseOp`, parked
with "Do it anyway" / "Discard" like any other. It gets **no** bespoke
width-merge: an earlier draft of this design said a conflicting resize would be
re-applied to the other side's text, which is a second conflict path for a
one-line change and is hereby dropped. Nothing about images reaches the bucket
except through the paths an edit already uses.

**Moving an image moves a line.** Drag the grip and one line changes places
between two others, with the insertion point taken from CodeMirror's own
`posAtCoords` so a drop lands where the editor would put a caret. Dropped on
another row, the two join — that is the side-by-side gesture, and it is one line
edit. Free positioning is **deliberately not built**, and this is the reversal
rather than an omission: x, y, rotation, float, z-order and a crop box all need a
store, the only store is the file, and the file has no room for them — so they
would land in a shadow layout document beside every note, which is non-negotiable
#3 ("plain files stay canonical") traded away for arrangement. The escape hatch
already ships and is the honest one: paste into a **drawing**, where an
`.excalidraw` file is a canvas format that carries coordinates because that is
what it is for, and which embeds back into the note as one line.

**The object is named from its own content**: sixteen hex characters of SHA-256,
at `attachments/<YYYY>/<MM>/` by default. Hashing buys three things at once — the
same paste in three notes is one object, a retried upload is idempotent rather
than leaving `-1` behind, and a clipboard with no filename needs no invented one.
The key is derived by the server rather than supplied by the client, because a
client-chosen path is a path to argue about, and `assertAttachmentPath` refuses
whatever comes out of the derivation if that is ever changed carelessly.

**Bytes are never inline and never remote.** No `data:` URI in the Markdown — it
destroys `git diff`, `grep` and every reader's idea of a paragraph — and no host
of ours in the link, which is `share/markdown.ts`'s rule already: a remote image
in a shared note is a tracking pixel that reports every read to whoever wrote it.
Inside the `WebView` the bytes do cross as a `data:` URL, and that is the same
rule rather than an exception to it: the guest holds no credentials and must not
be handed a URL it could fetch, because a URL it could fetch is a URL a note
could name.

**Offline needs something the mirror does not have, and this says so rather
than assuming it.** #696 is explicit that attachments are listed and never
downloaded, and that stands: this does not make the mirror fetch images. What a
paste needs is the other direction — an **outbound staged blob**, keyed by the
hash the device computed itself, which is exactly why the line could be written
offline and still be correct when the bytes arrive. Until that staging exists, an
offline paste is refused in a sentence, following #701's precedent for a folder
op: refuse honestly rather than queue something that cannot be made right.

**The rest of the product applies without special cases.** A `member` sees the
image and no handles at all, because write is a separate grant from read and a
greyed-out control is a worse way to say so. Through a folder share link the
image is re-derived through the live `privacy.md` at `team` scope with no granted
names, so an image only a private note embeds is **absent**, not merely
unlinked. A paste over the size ceiling is refused in the store's own words
rather than silently recompressed: the customer's bucket, the customer's bytes,
the customer's bill.

**An encrypted note refuses a paste outright**, and that is a decision rather
than a gap. Its text is encrypted on the device and an image's bytes are not, so
storing one beside it would put in the clear exactly what somebody turned
encryption on to keep out of it — in the same bucket, under a name the note
itself spells out. Encrypting attachments is real work that
[`encryption.md`](../encryption.md) scopes, and until it is done a refusal
somebody can read beats a paste that quietly weakens what they asked for.

**What a simplification of this costs.** Moving the width into an `<img>` tag
buys wider rendering and loses every image the first time its note is renamed.
Storing a position, an alignment as anything but a comment, or a crop box buys
arrangement and costs the claim that the Markdown is the whole note. Making the
width a percentage or a per-device value buys a nicer phone and costs "one file,
read the same everywhere". Writing the line before the object trades a
recoverable orphan for a broken note. Putting the bytes in a visible folder buys an embed that
resolves in Obsidian and costs a second image store, a new folder in everybody's
file tree, and an agent that cannot read what somebody pasted. Dropping the reference
gate on reads buys one round trip and turns a visible folder into a way for a
member to read what a private note holds.

**The tests that hold it.** `imageLine.test.ts` (26 checks) is the grammar: a
sentence with an image in it is not a row, an alias is not a width, `left`
removes the directive, an unknown directive key survives an alignment change.
`imageBlock.test.ts` (44) is every gesture as a planner — the row that stays
drawn wherever the selection is, what the toolbar writes (alt into the alias
slot, Replace keeping the width, Remove taking the line rather than leaving a
blank one), the clipboard pair where both lists hold the same image, the
snapping and `⌥` turning it off, a drop onto a paragraph moving the line, a drop
onto a row joining it, the blank-line arithmetic of moving a block, and base64
byte for byte against the platform's own encoder. `pasteImage.test.ts` (8) is the derived
name: a type the store cannot serve has no name at all, a hash that is not a
hash is refused rather than producing a junk key, and every name it can produce
round-trips through `writeImage`'s own leaf rule — a key that rule refuses is
bytes nobody could ever get back out. `imageBrowser.test.ts` (5) is the console's side:
the cache that keeps a keystroke from being a round trip per picture, a server
refusal passed through in its own words, and an encrypted note refusing before
the bytes leave the device. `webviewHost.test.ts` (6) is the bridge: every branch
replies, a read-only note refuses before the sink is reached, junk base64 is
refused rather than stored truncated. `files.test.ts` holds the reference gate —
a `member` naming the private note gets the same `FILE_NOT_FOUND` as for a note
that never existed, naming a visible note does not help, and the owner still
reads it — and it was that file's own endpoint table that noticed the two new
actions were missing from it. Sabotaged by disabling the reference check: two of
those go red, which is the point of writing them.

**What is not built, stated rather than implied.** An embed into `IMAGE_PREFIX`
does not resolve in Obsidian, per the reversal above. Images are still not in the
offline mirror, per #696 above.
And there is no crop, which is the one on this list worth doing next: a crop that
writes a new object needs no new numbers in the file, which is what made every
other item here expensive.

