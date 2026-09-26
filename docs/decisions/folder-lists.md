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

`group` groups either kind of list by one property, lifecycle words first
(`active`, `planned`, `paused`, `done`…), other values a to z, and the rows
with no value last as "No status" — the nudge to mark something, without
colour. `as: board` draws the same grouped rows as columns of cards and
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
`apps/mcp/test/listSetProperty.test.mjs` fails if the change touches any other
byte or writes a value that reads back differently; `useFolderListsEdit.test.ts`
fails if a member is offered the edit.
