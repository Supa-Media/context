# Folder lists

A note may carry a fenced ` ```list ` block that shows the notes in one folder,
filtered by their properties, as links that stay current:

```
```list
from: 1-projects
where: status is active
sort: updated, newest first
show: owner, updated
```
```

Asked for by the owner on 2026-09-24 while reviewing the website folder
designs: a blog index should be "just a note that lists a folder", and the same
block should give any note a live "all current projects" list. The grammar and
the row selection are `apps/mcp/src/lists.js`, pure and imported by the app, so
every surface that draws a list picks the same rows.

## Nothing about it is website-specific

A blog index on a public website and a projects list in a private note are the
same block. That follows from the owner's rule that a website page is just a
note: if lists were a website feature, the website folder would stop being an
ordinary folder. A "simplification" that gave websites their own index block
would bring back the "create a website page" flow the owner rejected.

## Selection only ever narrows

`selectListRows` receives the notes its caller can already see and filters,
sorts and trims them. It never fetches. Privacy, share scope and drafts are
decided before it runs, so a list cannot show a note the reader could not open.
It also refuses `.context/` plumbing and the note holding the block even for a
config that skipped the parser, so a hand-built config cannot widen it.
Test: "a config that skipped the parser still never lists plumbing" in
`apps/mcp/test/lists.test.mjs`.

## A block that does not parse draws its error

The same discipline as forms and `privacy.md`: an unknown key, a folder that
climbs out with `..` or points into `.context/`, or a condition without an
operator is refused with its line, and the surface shows that error in place of
rows. A best-guess list is the failure people don't notice.

## The filter lives in the block

An editor that lets someone change a filter rewrites the block's text with
`renderListBlock`, so the Markdown stays the whole truth and another client
reads the same list. `parseListBody(renderListBlock(c))` must equal `c`; the
round-trip check fails if a key is dropped.

The console's popover on a list's caption is that editor. It writes each
complete version as it is chosen, keeps a half-written condition in the
popover until it has a property and a value, and refuses a version that would
not read back as itself (a folder that climbs out, say) with the grammar's own
reason rather than writing it. Its choices therefore never live anywhere but
the note. `listBlock.test.ts` ("changing a list from its caption") fails if a
choice is kept in the popover instead, or if a half-written condition reaches
the note.

## A project is anything with a status

`rows: projects` turns a list's rows into projects, and there is no project
type behind it. A note directly in the listed folder is a project when its
frontmatter has a `status`; a folder is one when its front note does, the
first of `overview.md`, `index.md` and `README.md` that exists. A folder
project's name is its front note's `title`, then its first heading, then the
folder name, and its `updated` is the newest save anywhere inside it.

Sub-projects are found the same way one level down, and nowhere deeper, so a
list is at most two levels. A team with many projects needs one level of
breakdown to stay legible; an unbounded tree turns a list back into the file
tree it was meant to summarise. A filter keeps a parent when it or any child
matches and carries only the matching children, so "owner is me" shows my
work under its projects, while progress still counts every sub-project: a
filter that hid finished work must not make a project look less finished.

`group` groups either kind of list by one property. Grouped by `status`, the
groups are the listed folder's status groups — No status, Not started, In
progress, Done, then words in no group (see "Status groups" below). Grouped by
anything else, lifecycle words come first, other values a to z, and the rows
with no value last. `as: board` draws the same grouped rows as columns of cards and
needs a `group`. Its columns include every value the listed notes use, so
there is somewhere to drop a card before anything is in it. Dropping a card
is the value menu's write made by hand, and never the only way: each card
keeps its own value button for a keyboard or a phone, where drag and drop
does not reach (`apps/mobile/__tests__/listBoard.test.ts`).

A "simplification" to a project type, a projects database, or a tag would
cost the thing this rests on: a project stays a note or folder any other tool
can read and move. `apps/mcp/test/listProjects.test.mjs` fails if a folder
with no front note becomes a project, if plumbing bumps a project's
`updated`, or if progress counts only the shown sub-projects.

## A list changes one line of a note, the same way any save does

An owner or editor can change a row's status or owner from the list itself.
The value opens a menu of the words the listed notes already use, and the
choice is written by reading that row's note, changing that one frontmatter
line with `setNoteProperty`, and writing it back through `files.writeNote`
against the version read — the path every other save takes, so it merges into
anybody typing in the note at that moment instead of overwriting them. Every
other byte of the note is left alone, and a value the reader could not read
back as written is refused with the reason rather than saved.

It is a menu on the list and not a projects database because the note stays
the record: the next person, the next agent, and the website all read the
same line. A member is not offered the menu at all (the server refuses the
write too), and a list-valued property is never offered as one choice.
`visibility` is never written this way either, from a list or a folder page:
who can read a note is `privacy.md`'s answer, set with Share, and a
`visibility:` line would be a description that disagrees with it. The refusal
is in `writeNoteProperty` itself, the one road these writes take, before the
note is even read, and a list draws the value as plain text
(`listBlock/writable.ts`, the same rule the Properties panel keeps).
`apps/mcp/test/listSetProperty.test.mjs` fails if the change touches any other
byte or writes a value that reads back differently; `useFolderListsEdit.test.ts`
fails if a member is offered the edit; `listEdit.test.ts` fails if
`visibility`, in any case, is offered or written.

## A folder page shows its children by status

A folder's own page is where projects are seen and set, with no block to write.
Every folder page offers **Files · List · Board** on its title's row: Files is
the listing as it always was, List groups the folder's children by `status`,
Board draws the same groups as columns. A folder opens in List once anything
in it has a status, and in Files otherwise; what each viewer picks is
remembered per folder in that browser's storage, never shared and never
required. When two or more subfolders exist and nothing has a status yet, one
quiet line offers an owner or editor the list, and closing it is per viewer
too; a member, who could set nothing there, is not offered it.

It differs from `rows: projects` on purpose. A list block shows what already
*is* a project; a folder page is where something becomes one. So every folder
and every note in the folder is an item, and everything unset sits in one
"No status" group, first in Not started, with `Set status`, rather than being
left out or held back in a bucket of its own. A note's status is written into the note; a folder's into
its front note by the same `overview.md` > `index.md` > `README.md` order; and
a folder with none gets a new `overview.md` holding only that frontmatter —
the menu says "Saves to overview.md" before anything is pressed. The
`README.md` a new folder is made with does not count while it still says only
that it is a placeholder: a status written there would live in a file the
console does not list and whose own text says to delete it. The create is the
ordinary one — `files.writeNote` with no version, which the server refuses if a
note appeared meanwhile, and that refusal is read and retried like any conflict,
so nothing is ever replaced.

The Board has a column for every status in the folder's status list, drawn
under its group, and a column for each other word in use where its group puts
it — so a folder where everything is `in progress` can still move something to
`finished` without typing a word. For somebody who can write, "No status" leads
Not started even when empty, because dropping a card there is how a status is
cleared by hand; a member sees it only with something in it. On web a card is dragged to
another column (HTML drag and drop, the gesture the list block's board uses),
and the drop is the menu's choice made by hand: it goes through the same
`choose`, shows at once, and comes back with the reason if refused. The drag
is never the only way: every card keeps its status button, drawn rather than
hidden until hover, so a keyboard or a phone moves it through the menu. A
quiet value in the List shows when a keyboard focuses it, as it does under the
pointer. While a choice is on its way the page says "Saving…".
`folderPageView.test.ts` fails if a drop does not write through the menu's
road, if No status does not clear, if a member's card moves, or if a drag that
is not a card is taken; `folderPageModel.test.ts` pins the columns and what a
drop writes.

A project folder's page is titled by its front note (the title opens it) and
says `status · owner · updated` under the title, with the note's first
paragraph beneath, and the Files listing below that. It never renders the
whole note: that would be two places to edit one note.

Everything is read from the same device copy a list block reads, at the role's
clearance, so the page can only describe notes the reader could already open;
and the writes are the list's own (`writeNoteProperty`), gated the same way —
owner and editor, never member. `apps/mobile/__tests__/folderPageView.test.ts`
fails if a member is shown a control, if a folder's status goes anywhere but its
front note or a new `overview.md`, or if the unset items are not one group;
`folderPageModel.test.ts` pins the front-note order and the placeholder rule;
`listEdit.test.ts` fails if a missing note is created without being asked.

## A list write is what this device holds afterwards

Folder lists and folder pages read notes from this device's mirror, so a write
made from them has to move the mirror too, or the page shows the old value the
moment the in-memory overlay that drew the choice is gone — which is what a
reload does. Reported as "I refresh and it goes back to the value": the write
had landed, and the mirror kept the old copy until a sync fetched it, and that
sync announced only its metadata commit, which comes before the bodies.

So a successful list write reads the note back from the bucket and puts it
into the mirror through `putMirroredNotes` — the writer an online open and the
sync use, which keeps any ancestor a queued edit still needs — and says the
notes changed; and a sync that committed new bodies says so too (`onFetched`),
and folder lists re-read on either. It is read back rather than composed from
the text sent because the bucket may have merged the write into somebody's
typing, and a new `overview.md` needs the visibility fields only a read
carries. The overlay is still only an overlay: it is dropped once the device's
copy agrees, never kept to paper over a stale copy. If the read-back fails the
write stands and the next sync brings the note (`offline/folderListSource.ts`).
`folderListWriteBack.test.ts` fails if a chosen status or a folder's first
`overview.md` is gone after a reload, or if the sync stops saying it fetched.

## Status groups

Decided by the owner on 2026-09-26, after a board showed "Active" and "In
Progress" as two columns, three empty columns nobody asked for, and
"Exploration" sorted after Done. Before this there was no list of statuses:
every word typed became a column, four starter words were always added, and
two hidden English word lists decided the order and what counted as finished.

**Every status belongs to one of three fixed groups: Not started, In progress,
Done.** The groups are the product's opinion and never change; they decide the
order a board and a list are drawn in, what a project's "3 of 5" counts as
finished, and what `where: status is done` (or `is in progress`, `is not
started`, `is open`) matches in a list block. The words inside the groups
belong to a folder.

- **The list is three frontmatter lists in the folder's front note**:
  `statuses-not-started`, `statuses-in-progress`, `statuses-done`. Three flat
  keys, not one nested map, because the frontmatter reader is deliberately not
  YAML (`lists/properties.js`) and a list only one surface could read would be
  a second format. A note still says only `status: in review`; its group is
  looked up, never written into it, so a moved note takes on its new folder's
  meaning.
- **Inherited** from the nearest folder above that declares one, up to but not
  including the workspace root, whose front note is the workspace's front page.
  With none anywhere, the defaults are No status, In progress, Finished.
- **"No status" is the empty value**, always first in Not started, never a
  word: clearing stays a one-line delete.
- **Every group keeps a status.** An empty In progress or Done reads as its
  default, and the editor refuses to save one.
- **A status is added to a group, never typed loose onto a note.** The status
  menu offers the folder's statuses under their group names and "Edit
  statuses…", not "New value…".
- **Words nobody declared are never guessed into a group silently.** Ordinary
  lifecycle words (`active`, `shipped`: `KNOWN_WORDS`) are drawn in their
  group like any status, with no prompt. Anything else is drawn in **No group
  yet** after Done, and the one question it raises is a Choose group control
  on its own heading (the List band, or its Board column), for an owner or
  editor only.
- **Nothing about a folder's words is ever said above its contents.** The
  first cut stacked a sentence per word between the header and the list
  ("is on 4 items here and reads as In progress. Merge into In progress ·
  Keep as a status"), and the owner rejected it outright (2026-09-26): a page
  that nags on every visit is worse than a word left where it is. Tidying
  (adding a known word to the list, or merging it into its group's first
  status) lives in "Edit statuses…" under "Used here, not in this list".
  Merging rewrites notes, so it names the count first.
- **An edit goes where the list lives**: the front note that declared it, or
  this folder's own front note while it only has the defaults. A subfolder
  never quietly forks its parent's list.
- **Renaming or deleting a status rewrites the notes that use it**, after a
  confirm naming how many, so notes never disagree with the board. A delete
  moves them to the next status in the same group, or to No status. The notes
  are every note under the list's folder that the list describes, read fresh
  from the device at that moment.
- **Agents are told.** `scope_info` with a path lists that folder's statuses;
  `write_note` saves a status outside the list and says so afterwards, with the
  list. It never refuses: the file is the person's. Both read the front notes
  through the caller's own clearance, passing over one it cannot see exactly
  as the app's device copy does, so nothing about a held-back note leaks.

A "simplification" back to free words costs the board its order and its
meaning: `apps/mcp/test/listStatuses.test.mjs` fails if a group loses its
default, if inheritance stops at the folder, if `status is done` stops reading
the group, or if an agent is told a list from a front note it cannot see;
`folderPageStatuses.test.ts` pins the bands, No group yet, and which notes a
rename rewrites; `folderPageView.test.ts` pins the grouped menu, the board's
bands, and that a word nobody placed asks only on its own heading, never to a
member and never in a sentence on the page.

## An owner is picked, never typed

Asked for by the owner on 2026-09-26, from a folder's List view whose owner
menu offered `Sayo`, `Seyi`, `Seyi Olujide` and "New value…": one person with
three spellings, and a field for a fourth. An owner is now **somebody in the
workspace, an agent connected to it, or `any agent`**, on every surface that
sets one — a folder page's List, a project's own line, and a list block in a
note. There is no field for a new owner anywhere.

- **The search runs on the server.** `owners.searchOwners` (control plane)
  takes what was typed and returns the best eight members and a few agent
  names, never the roster, so a workspace of a hundred people is searched
  where the people are. It reads at most a thousand memberships; past that it
  says so and a narrower query finds the rest. The app asks a moment after
  typing pauses.
- **The order, with nothing typed**, is the owners the folder already uses
  (most used, then most recently saved), then the reader, then everybody else
  a to z. A folder word that is somebody's first name counts as them, so a
  hand-typed `Seyi` offers the member `Seyi Olujide` first. With something
  typed: whole name, start of the name, start of any word, start of the
  address, anywhere — accents and case ignored. "Jev smarts" was asked for and
  nothing by that name exists in the repository or the owner's notes; this
  ranking is the stand-in until it is named.
- **Agent names come only from grants the reader could already list.**
  `grants.listGrants` shows an owner every grant and anybody else only their
  own, because a colleague's tooling is theirs to disclose; the picker keeps
  that line and returns names only, never who connected an agent, when, or
  with what scopes. The console's own grant is not offered.
- **What is written is the plain name** (`owner: Sayo`, `owner: Claude`,
  `owner: any agent`), so the Markdown still reads in any editor and a filter
  like `owner is Sayo` keeps working. A member with no name is written as
  their address.
- **An owner already written by hand is left alone.** Nothing is rewritten
  behind anybody's back: the value is still drawn, and its picker leads with
  it, checked and marked "Not a member", beside the member it most likely
  meant, and "No owner" clears it.

`apps/convex/__tests__/owners.test.ts` fails if a non-member gets anything
but the missing-workspace refusal, if a member of another workspace is
offered, if more than the limit comes back, or if an editor is shown a
colleague's agent; `apps/mobile/__tests__/ownerPicker.test.ts` fails if the
picker offers a way to type an owner, stops asking the server, or drops a
hand-typed owner; `listEdit.test.ts` pins the same in a list block.
