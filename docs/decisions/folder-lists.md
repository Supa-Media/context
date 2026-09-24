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
