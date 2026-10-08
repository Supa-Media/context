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

**What is not built yet**: moves and renames written to the table first,
ahead of the bucket copies. The apps' catch-up and the links table are below.

**What a simplification would cost.** Filtering rows by a visibility stored in
the table would make the table a second privacy engine that goes stale when
`privacy.md` changes. A shared table with a workspace column would end the
per-context boundary. Serving a table that has not finished a sweep would draw
a tree with folders missing and call it complete.

**A stalled fill says why.** A sweep pass that throws records its message
beside the table (`tree_error`, in the context's own database), and the next
pass that moves on clears it. The staff panel shows that row as **Stuck** with
a fixed, path-free reason. Raw errors remain in the workspace database and
never reach staff: filenames with spaces cannot be reliably scrubbed from
arbitrary errors. Before this, a fill that failed at the
same key on every pass only looked slow (2026-10-08).

### Apps catch up from a change log, and a deletion is told only to those who could see it

*Decided 2026-10-08, owner's plan (b).* The tree table keeps `tree_log`: one
row per key whose version changed or which left, stamped with the database's
own clock, kept 30 days. An app's copy that walked the whole tree in the last
hour asks `syncTreeChanges` for what changed since its cursor instead of
walking again; a walk's first page hands out that cursor.

A deletion forgets the `privacy.md` overrides that named the note, so judging
a "gone" row by today's rules would tell a teammate the name of a note that was
private. The row records who could see the key *before* it left, and a reader
hears about it only when their audiences meet that set (an owner always does).
A key that left in a way nobody recorded the audience of is told to no one, and
the hourly walk clears it. Any change to `privacy.md`, a cursor older than the
log, or a log that does not reach back answers `full: true`, and the app walks.

What fails if reversed: `apps/mcp/test/treeChanges.test.mjs` (gone rows,
audiences, overlap), `apps/convex/__tests__/treeChanges.test.ts` (privacy
version and `full`), and `apps/mobile/__tests__/offlineMirrorChanges.test.ts`
(a catch-up never prunes what it did not hear about).

### Links live beside the tree, and "who links here" is one query

*Decided by the owner, 2026-10-08* ("if we have a table, it should be a way to
see all the notes that reference a note being moved/renamed and update all
references automatically because we have a list of them"), and built ahead of
moves-in-the-table ("Links now"), so moves can be built on top of it.

`tree_links` holds one row per link: the note it is in, and what it names,
parsed by the same `parseLinks` and `linkTargetOf` a rewrite runs
(`apps/mcp/src/links.js`). A link that names a path is stored resolved against
its note's folder (`kind: path`); a bare `[[name]]` is stored as the name
(`kind: name`), because which note carries a name is a question about the
whole bucket and is answered when read. It is indexed by target.
`tree_link_sources` records the version each note was parsed at; a note whose
tree row has another version is **unparsed**. No note text, no visibility.

**How it stays current.** An editor save records its links in the same
request as its search row and tree row, at the same version
(`writeProjection.js`). Everything else (a tool's write, a move, a file
changed outside the product) changes the tree row's version and so leaves the
note unparsed, and a fill pass reads it again: in the tree's own chain once a
sweep finishes, after a console change to the tree's shape, and whenever the
map opens on a table with notes behind (`linkFillPass`, `treeTableOps.ts`). A
fill that leaves nothing unparsed prunes the rows of notes that left and marks
the table ready. Every read joins on `tree`, so a note that left is never
answered for even before it is pruned.

**A move reads only the notes that can hold a link to it.** `linkCandidates`
answers: every note with a `path` row naming a moved path, every note with a
`name` row naming a moved note's bare name, every moved note itself (its own
relative links change depth), and every unparsed note, since it may have
gained a link since it was read. Names are still resolved against every note
in the tree, so a name that is ambiguous across the bucket stays ambiguous and
is not rewritten. A table that is not ready, is dirty, or has more than 500
unparsed notes is not trusted, and the move walks the bucket as before. This
replaced the move's inventory walk (a page of the bucket per pass, up to 100
passes) with one pass. Cost, stated: a note written in the seconds before a
move and not yet in the tree is not read; links inside it to the moved note
stay as written, as links in an encrypted note already do. The walk used to
repair, in passing, links still naming notes moved long ago (the forwarding
ledger); a move now reads only its own candidates, so those wait for a move of
their own target.

**The map reads it instead of the search index** once every note has been
parsed once: the notes and the links in a few paged queries, run several at
once, and no shard. Privacy is unchanged: a note is drawn only if `canSee`
passes, a link only if both ends are drawn, and a bare name resolves to the
note of that name beside the linking note, else to the one drawn note carrying
it, never to a hidden one. Notes still unparsed make the map say it is
catching up (`behind`). Until the table is ready, the map reads the index as
before.

What fails if reversed: `apps/mcp/test/treeLinks.test.mjs` (rows a rewrite
would act on, fill and prune, candidates by path and by name, refusals, a
rewrite that reads only candidates and keeps bare names ambiguous across the
whole bucket), `apps/convex/__tests__/workspaceGraphLinkTable.test.ts` (the
map from the table equals the map from the index at owner and team clearance,
a held-back note and its links absent, the index not read) and
`treeTableOps.test.ts` (a finished sweep goes on to the links).
