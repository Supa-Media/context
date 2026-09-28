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
Every projects folder page offers **Notes · List · Board** on its title's row:
Notes is the listing as it always was (called Files until 2026-09-28: "files"
is a word for the storage, not for what is in it), List draws the folder's
tasks by `status` and then its plain notes, Board draws the tasks as columns.
A folder opens in List once anything in it has a status, and in Notes
otherwise; what each viewer picks is remembered per folder in that browser's
storage, never shared and never required. When two or more subfolders exist
and nothing has a status yet, one quiet line offers an owner or editor the
list, and closing it is per viewer too; a member, who could set nothing
there, is not offered it.

It differs from `rows: projects` on purpose. A list block shows what already
*is* a project; a folder page is where something becomes one. So every folder
and every note in the folder is an item: one with a status is a task, and one
without is drawn as a note with **Make it a task** beside it (see "Tasks and
notes"), rather than being left out. A note's status is written into the note; a folder's into
its front note by the same `overview.md` > `index.md` > `README.md` order; and
a folder with none gets a new `overview.md` holding only that frontmatter —
the status menu says "Saves to overview.md" before anything is pressed, and
the button says it to a screen reader. The
`README.md` a new folder is made with does not count while it still says only
that it is a placeholder: a status written there would live in a file the
console does not list and whose own text says to delete it. The create is the
ordinary one — `files.writeNote` with no version, which the server refuses if a
note appeared meanwhile, and that refusal is read and retried like any conflict,
so nothing is ever replaced.

The Board has a column for every status in the folder's status list, drawn
under its group, and a column for each other word in use where its group puts
it — so a folder where everything is `in progress` can still move something to
`finished` without typing a word. It draws tasks only: there is no "No status"
column, and clearing a status (which turns a task back into a note) is the
status menu's "No status". On web a card is dragged to
another column (HTML drag and drop, the gesture the list block's board uses),
and the drop is the menu's choice made by hand: it goes through the same
`choose`, shows at once, and comes back with the reason if refused. The drag
is never the only way: every card keeps its status button, drawn rather than
hidden until hover, so a keyboard or a phone moves it through the menu. A
quiet value in the List shows when a keyboard focuses it, as it does under the
pointer. While a choice is on its way the page says "Saving…".
`folderPageView.test.ts` fails if a drop does not write through the menu's
road, if a note becomes a card, if a member's card moves, or if a drag that
is not a card is taken; `folderPageModel.test.ts` pins the columns and what a
drop writes.

A project folder's page is titled by its front note (the title opens it) and
says `status · owner · updated` under the title, with the note's first
paragraph beneath, and the listing below that. It never renders the
whole note: that would be two places to edit one note.

Everything is read from the same device copy a list block reads, at the role's
clearance, so the page can only describe notes the reader could already open;
and the writes are the list's own (`writeNoteProperty`), gated the same way —
owner and editor, never member. `apps/mobile/__tests__/folderPageView.test.ts`
fails if a member is shown a control, if a folder's status goes anywhere but its
front note or a new `overview.md`, or if an unset item is drawn as a task;
`folderPageModel.test.ts` pins the front-note order and the placeholder rule;
`listEdit.test.ts` fails if a missing note is created without being asked.

## Tasks and notes

Decided by the owner on 2026-09-28 ("Projects for everyone"). Before this every
child of a project without a status sat in a "No status" group at the top of
Not started, so a project's reference notes — the budget, the market research
— read as a pile of tasks nobody had started, and the list could not say what
was actually to do.

- **Anything with a `status` is a task; anything without is a note.** The List
  draws the tasks by status and then a **Notes** section ("Notes 3 · no status,
  so not tasks"), each note with a document icon (a folder icon for a folder),
  who owns it and when it was saved. For an owner or editor, **Make it a task**
  (shown on hover or focus, always on a phone) writes the folder's first Not
  started status that is not backlog — `to do` by default — through the same
  `writeNoteProperty` road as the menu. On the projects folder itself, whose
  rows are projects, it reads **Make it a project**: a project folder with no
  status is a note there too, which is what "A project is anything with a
  status" already says.
- **Backlog is a folded band first, the Done group a folded band last.**
  `backlog` in any case is drawn as one line ("Backlog 12 · Ideas and later
  work, out of the way") that opens in place; the Done group ("Finished" when
  it is one status) folds the same way at the end of the tasks. Words nobody
  placed are drawn before it, so a fold never hides the one question the page
  asks. A section holding one status is named by it ("To do"), and by its
  group when it holds several, each then under its own heading.
- **A task that is a folder holds subtasks and notes**, one level down and no
  deeper: its row carries "2 of 4 done" and a chevron (only when it holds
  anything), and opened it shows its subtasks and then "NOTES IN THIS TASK".
- **Subtasks count, notes do not.** Progress is closed subtasks of all
  subtasks, as it always was; a plain note inside a task is never a subtask.

A "simplification" back to one "No status" group costs the reason for the
change: a project's notes drown its tasks, and "Make it a task" has nothing to
distinguish. `folderPageTasks.test.ts` fails if a statusless child becomes a
row of a status group, if Backlog stops leading or Done stops closing the
tasks, if a subtask's notes are counted, or if Make it a task writes backlog;
`folderPageList.test.ts` fails if the bands stop folding, if a member is
offered Make it a task, or if the button writes anywhere but the note.

## Priority, tags, due and several owners

Decided by the owner on 2026-09-28, with the same rule as statuses: each is a
frontmatter line anybody can write by hand, and the page draws what the line
says rather than keeping a second copy.

- **Priority is a fixed scale**, `priority: p0` to `p3`, said as Urgent, High,
  Medium and Low (and "No priority"), like the three status groups: the product's
  opinion, not a folder's list. The UI never says `p0`. It leads each row as a
  glyph with no hue — an ink square with "!" for Urgent, three signal bars
  with three, two or one lit, a faint dash for none — because red means
  failure in this palette. Rows run by priority, then newest, inside each
  group. Anything that is not `p0`–`p3` is no priority, never a guess.
- **`owner:` may name several** (`owner: [@sayo, Claude]`). A row shows the
  first owner's face and name and "+1": a person's round face with initials,
  an AI helper's rounded square with a robot (never "AI" in letters, which
  reads as initials), and a dashed "?" with "No owner" for nobody. A line
  naming several is shown and never offered as one choice, since picking one
  would drop the others — the rule a list block already keeps for list-valued
  properties. A single line is one owner even with a comma in it.
- **`tags: [a, b]`** are free words, drawn as small chips (two, then "+N");
  kinds of work (bug, feature) are tags, not a type property.
- **`due: 2026-10-03`** is a calendar day, read in the reader's own calendar:
  "Today", a weekday for the six days after ("Fri"), else "Oct 3" (with the
  year when it is not this one). A day already gone is never a weekday.

What reverting costs: a priority read from free words sorts "high" below
"low" and paints somebody's `urgent!!` as nothing; a typed owner field
brings back three spellings of one person. `folderPageTasks.test.ts` fails if
anything but `p0`–`p3` becomes a priority, if a list of owners loses one, or
if a past due date reads as a weekday; `folderPageList.test.ts` fails if
`p0` reaches the page, if the robot or the "?" face goes, or if a line of
several owners is offered as one choice.

## Show: whose tasks, per viewer

The List has a **Show** bar above its sections: Everyone · Mine · No owner N ·
Urgent N · Owner ▾, the last a searchable list of No owner, Me, the people and
the AI helpers the tasks name ("Any AI helper" for `any agent`), each with a
count. Counts are over every task, subtasks included. Under a filter a
section says "1 of 12", a group with nothing left is dropped, notes (which
are not tasks) are left out, and a task that does not match but has a
subtask that does stays, dimmed and opened on that subtask.

- **It is a way of looking, not a record.** It is remembered per viewer, per
  workspace, per folder in the browser's storage, like the view choice, and
  never written to a note: two people looking at one project see their own.
  A member has it too, since looking writes nothing.
- **Mine is the viewer's handle.** The host hands the page the viewer's own
  name and address, which the page resolves to their handle the way it
  resolves any owner word written before handles (`owners.resolveOwners`),
  only on a projects folder; an owner line is the viewer's when it names
  them or their own agent (`@seyi's Claude`). Where the page does not know
  who is looking, Mine is not offered.

`folderPageTasks.test.ts` fails if a count stops including subtasks, if a
parent kept for its subtask is not dimmed or carries the others, or if a
stored filter does not read back; `folderPageList.test.ts` fails if a filter
writes, if Mine stops matching by handle, or if it is not remembered.

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
  With none anywhere, the defaults are Not started: `backlog`, `to do` · In
  progress: `in progress` · Done: `finished`.
- **Backlog is a status** (decided by the owner, 2026-09-28). Until then Not
  started's default was empty and "No status" was the only way to say "not
  yet", so every stray note in a project read as a task nobody had started.
  Ideas and later work now say so with a word, `backlog`, and a note with no
  status is a plain note (see "Tasks and notes" above).
- **"No status" is the empty value, never a word**: clearing a status stays a
  one-line delete, and turns a task back into a note. It still reads as Not
  started wherever a group is asked for.
- **Every group keeps a status**, Not started included. A missing or empty
  group reads as its default — a folder whose editor once wrote
  `statuses-not-started: []` now reads backlog and to do there — and the
  editor refuses to save an empty one, which would only read back as the
  default. A folder that declares its own words keeps them; one whose list
  holds no backlog word simply has no Backlog band.
- **A status is added to a group, never typed loose onto a note.** The status
  menu offers the folder's statuses under their group names and "Edit
  statuses…", not "New value…".
- **Words nobody declared are never guessed into a group silently.** Ordinary
  lifecycle words (`active`, `shipped`: `KNOWN_WORDS`) are drawn in their
  group like any status, with no prompt. Anything else is drawn in **No group
  yet** — after Done on the Board, and before the folded Done band in the
  List, so a fold never hides it — and the one question it raises is a Choose
  group control on its own heading (the List band, or its Board column), for
  an owner or editor only.
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
default (Not started's is backlog and to do), if inheritance stops at the folder, if `status is done` stops reading
the group, or if an agent is told a list from a front note it cannot see;
`folderPageStatuses.test.ts` pins the bands, No group yet, that a statusless
note is not a band, and which notes a rename rewrites; `folderPageView.test.ts` pins the grouped menu, the board's
bands, and that a word nobody placed asks only on its own heading, never to a
member and never in a sentence on the page.

## An owner is picked, never typed

Asked for by the owner on 2026-09-26, from a folder's List view whose owner
menu offered `Sayo`, `Seyi`, `Seyi Olujide` and "New value…": one person with
three spellings, and a field for a fourth. An owner is now **somebody in the
workspace, one of the workspace's agents, or `any agent`**, on every surface that
sets one — a folder page's List, a project's own line, and a list block in a
note. There is no field for a new owner anywhere.

- **The search runs on the server.** `owners.searchOwners` (control plane)
  takes what was typed and returns the best eight members, never the roster, so a workspace of a hundred people is searched
  where the people are. It reads at most a thousand memberships; past that it
  says so and a narrower query finds the rest. The app asks a moment after
  typing pauses.
- **The order, with nothing typed**, is the owners the folder already uses
  (most used, then most recently saved), then the reader, then everybody else
  a to z. A folder word that is somebody's first name counts as them, so a
  hand-typed `Seyi` offers the member `Seyi Olujide` first. With something
  typed: whole name, start of the name, start of any word, start of the
  address, anywhere — accents and case ignored.
- **On Premium, the picker leads with who the note names.** Under
  "Suggested", above everybody else and not repeated below, is the owner Jev
  picked from the note being assigned (`owners.suggestOwner`, the
  `ownerSuggest` feature in `lib/jev/`). Jev chooses among the same people
  and agents the search offers with nothing typed, plus "any agent" and an
  explicit "none of these", which is no suggestion; confidence is not
  thresholded, because the way out is how Jev says it does not know. It
  reads that one note at the asker's own clearance, only an editor may ask,
  a locked note or one with `organize: off` is never sent, and nothing is
  written until the suggestion is picked. The search says whether to ask
  (`suggests`), so a workspace without it makes no call at all.
- **What is written is the member's `@handle`** (`owner: @sayo`,
  `owner: Claude`, `owner: @shay's Claude`, `owner: any agent`), so the
  Markdown still reads in any editor and a filter like `owner is @sayo` keeps
  working; never an address. A member with no handle is written by name.
- **An owner already written by hand is left alone.** Nothing is rewritten
  behind anybody's back: the value is still drawn, and its picker leads with
  it, checked and marked "Not a member", beside the member it most likely
  meant, and "No owner" clears it.

`apps/convex/__tests__/owners.test.ts` fails if a non-member gets anything
but the missing-workspace refusal, if a member of another workspace is
offered, if more than the limit comes back, if an address leaves, or if a
connected client is offered as an agent; `apps/mobile/__tests__/ownerPicker.test.ts` fails if the
picker offers a way to type an owner, stops asking the server, or drops a
hand-typed owner; `listEdit.test.ts` pins the same in a list block.
`apps/convex/__tests__/ownerSuggest.test.ts` fails if a locked, opted-out or
unseen note reaches Jev, if an answer that is not a candidate is suggested, if
a member who cannot write asks, or if the suggestion runs without Premium.

## Agents are a list the workspace writes, each optionally somebody's

Decided by the owner on 2026-09-28, after the picker offered "Context Sentry
incident inbox" beside Claude. Agents had been the names of the OAuth clients
connected to the workspace; that list is whatever each client's software
registered as, it includes integrations that file notes and never pick work up,
and a colleague's tooling is theirs to disclose. Agents are now **a short list
of words** the workspace keeps as text:

    agents: Claude, Codex, Cursor

- **It lives in a front note**, the way a folder's statuses do: the nearest
  folder at or above the page that declares `agents:` decides, and with none,
  Claude and Codex (`DEFAULT_AGENTS`, `packages/shared/src/agentOwners.ts`, so
  the app and the owner suggestion agree about "no list yet").
- **Anybody who can edit adds one by typing it** in the owner picker ("Add
  “Cursor” as an agent"). The line is written where it already is, or, while
  nothing declares it, into the projects folder's own front note (the outermost
  folder whose name says "project"), so every project under it offers the new
  name. A name the list holds in any case picks that one; a comma, colon, `#`,
  brackets, a leading `@` or `'s ` are refused, since they would break the one
  line or an owner line.
- **Whose is optional.** Choosing an agent asks "Whose Claude?": "Just Claude"
  first, then the members, written `owner: @shay's Claude`. Somebody's agent is
  a label, not a grant: it says whose session is expected to pick the work up
  and gives nobody access to anything.
- **Agents are marked in the owner column** — by the robot face in a
  project's List (see "Priority, tags, due and several owners"), and by the
  model mark on a project's own property line — so a column of people and
  agents reads without a word for it.
- The list-block menu inside a note writes an agent alone and offers no add;
  asking whose is the folder page's.

What a "simplification" costs: reading agents from grants again brings back
integrations, client-chosen names and the grant-disclosure rule. The server
never looks at grants for owners; `owners.test.ts` fails if a connected client
appears, `agentOwners.test.ts` pins the list's inheritance, home and name rules,
and `ownerPicker.test.ts` fails if choosing an agent writes without asking
whose, if adding forgets the front note, or if the robot face goes.
