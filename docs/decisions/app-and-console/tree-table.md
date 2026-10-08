# App and console — the tree table

### A workspace's tree is a table in its own database, and the bucket stays the truth

Decided by the owner, 2026-10-08 ("Build it"), after the side panel stayed slow
for @seyi (9,129 notes) even with the walk drawn as it landed: a bucket has no
folders and no rename, so a whole tree is a walk of every key, and three or
more sequential manifest calls of several list requests each is the floor for
that workspace. The owner asked for "a virtual representation" that keeps
quick operations working for up to 100,000 notes and folders.

**What it is.** A `tree` table in the context's own fast-search D1 database
(`apps/mcp/src/tree/table.js`): one row per key — path, version, size, time —
and no note text, no visibility. Top-level dot folders are left out. One
database per context, as for the search projection, because that is the
tenancy boundary.

**What it never decides.** Who may see a row. A tree read from the table is
the unchanged `syncManifest` handed a store whose `list` reads the table
(`tree/source.js`), so every privacy decision is still `canSee` over the live
`privacy.md` read from the bucket. A stale row can show a note that just moved;
it can never show a note to somebody who may not see it.
`apps/convex/__tests__/treeTable.test.ts` holds the table's tree equal to the
bucket's at every clearance, page by page.

**How it stays true.** Last observation wins. A sweep lists the bucket into it
a resumable piece at a time (`tree/sweep.js`); every write path re-checks what
a change touched — the key and everything under it as a folder — and records
what the bucket holds now (`tree/touch.js`): the gateway in `recordChange`, the
console in a scheduled `touchTree` that tells the open trees to look again only
after the table is updated. A save of an existing note's text records its new
version inside the search projection's own request, so the live editor costs
no extra call. Every row carries when it was observed; an older observation
never overwrites a newer one, a key seen gone leaves a tombstone a slower
listing cannot undo, and a finished sweep removes whatever nobody observed
while it ran. A change too big to re-check marks the table dirty, and the next
read starts a sweep. A table is swept again when read an hour after its last
sweep. A store that cannot resume a listing in key order (Dropbox) is never
served from the table.

**What starts a sweep.** Any first page of any tree walk, whether it can read
the table or not, and any console change to a table never filled or marked
dirty. Waiting for a reader that asks for the table was the first version's
mistake: the desktop and phone apps never asked, so no table anywhere was ever
filled (2026-10-08). Staff see every table and can fill them all at once in
admin › Search › Tree index (`functions/treeAdmin.ts`), which reads counts and
bookkeeping through the credential barrier (`treeState`), never a path.

**Who reads it.** Every tree walk asks for it (`source: "tree"`): a browser
tab's sidebar, and the desktop and phone apps' copy of a workspace.
The table answers once a sweep has finished, and until then, or where the
context has no database, the walk goes to the bucket as before. Served from
the table, a tab may walk again a second after the last walk rather than
fifteen.

**What is not built yet**, in the order agreed: the apps' copies catching up
from "what changed since my last sync" (rows by `at`, deletions by tombstone,
kept 30 days, a whole read after longer away); moves and renames written to the
table first, ahead of the bucket copies; and the map's links stored beside it.

**What a simplification would cost.** Filtering rows by a visibility stored in
the table would make the table a second privacy engine that goes stale when
`privacy.md` changes. A shared table with a workspace column would end the
per-context boundary. Serving a table that has not finished a sweep would draw
a tree with folders missing and call it complete.

**A stalled fill says why.** A sweep pass that throws records its message
beside the table (`tree_error`, in the context's own database), and the next
pass that moves on clears it. The staff panel shows that row as **Stuck** with
the message, quoted text and anything shaped like a key or file name taken out,
because the panel never shows a path. Before this, a fill that failed at the
same key on every pass only looked slow (2026-10-08).
