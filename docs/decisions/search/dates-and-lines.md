# Days, whole lines, and the pinned workspace (2026-11-05)

Three search changes the owner chose after the core benchmark's failures were
traced from its ledgers (round gh-178; the trace is in `@supa
projects/tex/handoff/2026-11-05-core-failures-traced.md`).

## A word-index snippet is the whole lines it touches

FTS5's `snippet()` is a twelve-token window, and it cut a line wherever the
window ended: "…40 m from Harbor Linen Mill, by October 20" left out "Place
the fabric order for the twill trousers:", so Tex answered without the word
that mattered in all six runs of "What do I have on October 20?". The window
is now widened to the whole lines it touches, from the chunk it was cut from,
at most three lines of 300 characters (`search/d1/query.js`
`wholeLineSnippet`). A workspace object widens it before the rows leave the
object, so the chunk never travels. The bucket path already quoted whole
lines (`snippetLinesFor`); the two paths now read alike.

**What a simplification would cost:** a wider window (more tokens) still cuts
a line somewhere. **Test:** `workspaceSearchIndex.test.mjs` "a hit's snippet
is the whole line it is on".

## A range of days is its own search

A word search ranks words and cannot sweep dates: "What's due in the last
week of October?" never showed "Slides due October 28". `search_notes` (and
v2 `search`) take `from` and `to` (YYYY-MM-DD, at most 14 days): each day is
searched the two ways notes write it ("October 28", "Oct 28") in every
workspace a search everywhere reaches, through the same `searchVisibleNotes`
and privacy, and only a line that names a day in the range is kept, day by
day (`tools/searchDates.js`). Words only: meaning search says nothing about
which day a line names.

**Test:** `searchDates.test.mjs`.

## A search everywhere leaves out the pinned workspace

Every account reaches `@context-lc` as a member, for its guides and Tex's
setup (`apps/convex/functions/lib/pinnedContext.ts`). A search everywhere
searched it like any workspace, so Tex's own prompt ranked among a person's
hits. It is now left out unless the person runs it (owner or editor) or the
app's scope picker names it; orient still shows its global note, and a call
with `context: "@context-lc"` still reads it.

**Test:** `searchEverywhere.test.mjs` "leaves out Context.LC's pinned
workspace".
