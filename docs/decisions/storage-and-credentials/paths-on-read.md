# Paths are built on read; a move is one row change

## The tree is parent pointers, and note files need not work outside Context

*Decided by the owner, 2026-10-25* ("The files do not need to work outside of
context ... editing, changing the name of a folder with a million items in it,
should be one row change ... Moving all of a project into another folder
should be one row change, changing the parent of a row"; "make sure you are
able to properly backfill or make this migration").

**Why.** [Notes by id](./notes-by-id.md) moved note bodies to
`notes/<noteId>.md`, so a move stopped copying bytes, but three things were
still filed by path and followed every note a move touched: each tree row's
stored `path`, each note's collaboration head, and the path text of links in
other notes. A folder move rewrote all three for every note beneath it, so it
was paged (`ROW_MOVE_MAX`), capped (`COLLABORATION_RENAME_MAX`), and slow
enough for an agent's move to time out.

**What it is.**

- A row's identity is its id; its place is its parent and its name. A path is
  computed from the rows when something is read (an agent, a person, an
  export) and never stored as the truth. Renaming or moving a folder of any
  size changes that folder's row and nothing else.
- Everything that points at a note points at its note id: editing history,
  links, pins and recents, routines, shares, the change log.
- People and agents are always shown paths, never ids. A link in a note is
  shown with the target's current path, worked out when the note is read.
- **Download as folders** still gives a complete copy with real names, built
  from the rows at the moment of export (non-negotiable 1 is unchanged). What
  is given up is that a bucket's raw keys or a note's raw link text read
  correctly outside Context; nobody may rely on that.

**Stages,** each merged and shipped on its own, each with a backfill for
existing workspaces that is confirmed finished in production before the next
stage relies on it:

1. Editing history filed by note id (below).
2. Links follow a move in the background (below): the move does no per-note
   link work.
3. Every row's parent and name are its path (below): the backfill that makes
   `parentId` and `name` say exactly what `path` says, checked in production
   before anything builds a path from them.
4. Rows stop storing `path`; paths are built on read, and a move or rename is
   one row patch. The link table points at note ids then, since it has no path
   to point at. The paged-move machinery (`rowMoves`, `drawnMoves`,
   `throughRowMoves`) goes with it.

What a "simplification" would cost: storing any path as truth again brings
back a write per descendant on every folder move, and a cap on how big a
folder may be before its move is paged or refused.

## Editing history is filed by note id

*Stage 1, built 2026-10-25* (`packages/collaboration/src/address.js`).

- In a keyed workspace a note's collaboration head is
  `.context/collaboration/v1/heads/notes/<noteId>.json`. The engine asks the
  store for the note id of the row at a path (`noteIdAt`), once per operation
  (`scoped`), and files the head there. A move of the note, or of a folder
  above it, leaves the head where it is: nothing is carried, and the
  document is found at whatever name the note has. A head filed by id is read
  at the note's current name; the state's own `path` is then informational,
  and validation does not compare it (`byNote`).
- Where the store can name no id (no row, plumbing, a trash location, a store
  with no id layer) the head is the path's, as before, so trash and restore of
  a path-filed head behave exactly as they did.
- **A path head is filed by id on its first read** (`adoptPathHead`): copied
  create-only to the id key, then fenced `moved` with `migrated: true`, so no
  read or move carries it again. A path head made for another note id is never
  taken. An id-less one (made before heads recorded ids) is, and `load.js`
  proves it is this note's (`adoptUnstampedHead`) before using it.
- **The backfill** (`fileHeadsByNote`, run per workspace by
  `functions/collaborationFiling.ts` from a half-hour cron) lists the bucket's
  path heads a page at a time and files each the same way, recording its
  position so a stopped pass resumes. The `Collaboration filing` workflow
  reports production's totals as counts.
- **A document records its note** (`documents/<documentId>/note.json`). An
  editor that typed at the old name before it heard of a move sends its update
  there with its document id; the collaboration route finds that note's
  current name (`pathOfNoteId`, the control plane's resolve) and commits there,
  judged by `canSee` like any destination. A name the member cannot see is a
  404, as a hidden moved head always was.
- **The move carry is now one read per note, and usually nothing else.** The
  gateway (`moves/keyedCollaboration.js`) and the console (`rowHistory.ts`)
  call `renameDocument` only where the old name still holds a live path head
  (`pathHeadLive`, one read, no lookup). `renameDocument` does nothing when
  both names file to the same head, so a stale name can never fence the note's
  own head. Rooms of a move of up to `ANNOUNCE_MOVES_MAX` notes are told where
  each went; a bigger move's rooms learn it when they reconnect.
- **Emptying the trash** erases a note's id-filed head and history by the id
  in its key (`historyIdsOf`), since its row is gone by then.

**The carry is gone** (2026-10-25, after the backfill reported every keyed
workspace done in production): a move calls no `renameDocument`, and the
gateway only tells the rooms of a small move where their notes went
(`announceMoves`). A trash and a restore still carry a head left at a path
(`rowHistory.ts`): a note trashed before this stage has its history at its
trash name, and Restore brings it back.

What a "simplification" would cost: filing heads by path again makes every
move carry each note's history and strands an offline editor whenever the
carry fails. `packages/collaboration/test/noteHeads.mjs` fails for each part
(the move, the first-read filing, another note's head, the stale-name rename,
the erase, the backfill), `apps/mcp/test/collaborationByNoteId.test.mjs` for
the route's forward and its `canSee`, and
`apps/convex/__tests__/collaborationFiling.test.ts` for the backfill's lease,
position and report.

## Links follow a move in the background

*Stage 2, built 2026-10-25* (`apps/convex/functions/linkRepairs.ts`,
`functions/lib/nodes/linkRepair.ts`).

- A keyed move queues the files it carried (`linkRepairs`, a page of
  `REPAIR_PAIRS` to an entry) when its rows have moved, and answers. A pass
  takes a workspace's entries oldest first, one pass per workspace at a time
  (a lease on the entry it holds), and runs each through the credential
  barrier as the `repairLinks` operation: the console's `rewriteReferences`,
  reading only the notes the link facts name. An entry that fails waits for
  the half-hourly cron; after `REPAIR_ATTEMPTS` it is dropped, and the
  forwarding ledger the move wrote keeps sending old links on, as it does
  until the pass lands.
- **Why not paths filled in on read.** That was the first plan for this
  stage. A note's text is a collaboration document that every editor, the
  search index, the website and the export all read; showing other text than
  it holds means every one of them learning to rewrite, and an editor typing
  over text it was never sent. A rewrite in the note itself, behind the move,
  keeps one text for everyone. What a move costs is unchanged by it, which is
  what the owner asked for: the move is the rows.
- **The pass runs as the owner,** so a private note's link follows too, which
  a member's move never reached. Nothing about what was rewritten goes back to
  the person who moved, so the count is no inference channel. A link is never
  pointed at a name narrower than its own note (`reachableRenames` in
  `fileOps/references.ts`, the gateway's rule): a `team` note's link to a note
  moved into a private folder keeps its old name.
- Before this a move in the app did not rewrite links at all (the console's
  `rewriteReferences` was no longer called), and a move through the gateway
  rewrote them in the request, the read of every note that could hold one.
  Both now go through the queue. There is nothing new stored to backfill;
  links an earlier app move left stale still forward to where the note went.

What a "simplification" would cost: rewriting links in the request again
makes a move's time grow with the notes that point into it, and an agent's
move time out. `apps/convex/__tests__/nodes/linkRepair.test.ts` fails for the
queueing, the narrowing rule and the queue's lease and attempts, and
`apps/mcp/test/keyedFolderMove.test.mjs` for a gateway move writing a note.

## Every row's parent and name are its path

*Stage 3, built 2026-10-25* (`apps/convex/functions/treeParents.ts`,
`functions/lib/nodes/parentCheck.ts`).

- Stage 4 builds a row's path from its parent and its name, so before then
  every live row of every keyed workspace must already say, through them,
  the path it stores. A check walks each keyed workspace's rows in path order
  a page at a time and sets `parentId` and `name` from the stored path, which
  is the truth until stage 4: the parent is the live folder row at the path's
  folder (none at the top level), the name is the last segment (`""` for a
  folder marker). A walk that set anything right is walked again from the
  next half-hourly tick, because a move during it can carry a row behind its
  position; a walk that sets nothing right is the workspace done.
- A live row whose folder holds no live folder row, and a path more than one
  live row holds, are counted and never guessed at. The `Tree parents`
  workflow reports them; stage 4 waits for both to be zero, or for each to be
  understood and fixed first.
- **Revised plan for what points at a note.** The first plan keyed pins,
  recents, routines, shares and the change log by id in this stage. Shares
  already follow `entryNoteId`. Pins, recents, folder icons and routines are
  followed per move by a read of the places under the moved name
  (`placesFollow.ts`, `remapIcons`), which costs what those few rows cost and
  not what the folder holds, and works the same once paths are built: they
  stay as they are. The change log writes two rows per file a move carries;
  in stage 4 a folder move writes one, and a device that hears of it walks,
  as it already does for a paged move (`movesMark`).

What a "simplification" would cost: building paths from parents before this
is done shows a note at a path it is not at, or not at all, and a move then
moves the wrong rows. `apps/convex/__tests__/nodes/treeParents.test.ts` fails
for a walk marked done after a repair, a duplicate path pointed at as if it
were right, an orphan pointed at a gone folder, and two chains on one
workspace.

## Paths built from parents: the switch

*Stage 4, started 2026-10-25* (`apps/convex/functions/lib/nodes/paths.ts`).

- `treePaths` builds a row's path from its parents and names (`pathOf`) and
  finds the row at a path by walking down from the top (`rowAt`, `liveAt`),
  remembering the folders one request has walked. A chain that loops, leaves
  the workspace, or reaches a missing parent has no path, never a wrong one.
  Every reader that leaves the stored `path` goes through it.
- **Why one switch per workspace, not reader by reader.** While stored paths
  are read, a folder bigger than one transaction moves its root first and
  its rows a page at a time, and readers and writers fold names through the
  move in flight (`throughRowMoves`, `moveOverlay.ts`). A writer that found
  rows by built path during such a move would make a second folder row at a
  name whose old row has not moved yet. So the readers and writers that use
  built paths run together, behind a per-workspace switch flipped only with
  no row move in flight; after it a move patches the moved row and nothing
  else, and nothing reads a stored path again. Workspaces flip one at a time
  and the stored column goes once every one has.

## Every reader asks the tree, not the stored column

*Stage 4b, built 2026-10-25* (`apps/convex/functions/lib/nodes/paths.ts`).

- No function outside `paths.ts` finds a row by its stored path. (The
  `by_workspace_path` index is still read for "any row at all" and for a
  purge of every row, which no path decides, and by the paged move and the
  parent check, which exist only on stored paths.) An exact name goes through `nodeAt` and `liveNodeAt`; a folder's
  contents through `below`, `rowsBelow` and `removalPage`; a resumable page
  through `walk`, `rows` and `rowsAfter`; and a row found some other way (by
  note id, by role, by parent) through `located` or `pathOf`. Each answers
  from the stored column or from parents, by the workspace's switch.
- **A row handed out carries its built path in `path`.** So code that reads
  `row.path` after finding a row is right in either mode, and needs no
  change when the column goes.
- **Walk order.** Built mode walks depth first by name, stored mode in byte
  order of the path; both resume after the last path read, so a cursor from
  one page is good for the next in the same mode. A removal deletes files
  first and folders only from a walk that read the whole subtree
  (`removalPage`), so no page leaves a row whose parent is gone.
- **The suite runs both ways.** `CONTEXT_TREE_PATHS=built` makes every
  workspace build its paths (it is a test switch: production sets it
  nowhere, and `deployEnv.test.ts` says why it is exempt). Tests that seed
  rows by hand give them parents (`parentRows`); tests of what only stored
  paths have (paged moves, their cap, the parent check) run on stored paths
  either way (`storedPathsOnly`, `onStoredPaths`).

What a "simplification" would cost: one reader left on the stored column
shows a moved note at its old name, or misses it, the moment a workspace
flips. Running the suite with `CONTEXT_TREE_PATHS=built` fails for each.

## A folder move is one row change

*Stage 4c, built 2026-10-25* (`apps/convex/functions/lib/nodes/builtMove.ts`).

- On built paths a move patches the moved row's parent and name and writes no
  row beneath it, in one transaction, whatever the folder holds: no cap, no
  pages, no move in flight. Only the root's name can be taken at the
  destination, since everything beneath keeps its name beneath it.
- **A folder of up to `ROW_MOVE_MAX` rows is still read**, and what followed
  each file follows it at once: the caller judges each file and the mutation
  checks the files it judged, link facts follow, and the change log names
  each file at both names. Reading a small folder is cheap, and it keeps the
  exact per-file judgement and the device feed's small catch-ups.
- **A bigger folder is not read at all.**
  - The caller judges it from the rules: the settings beneath it that hide
    what they cover from this caller (`hiddenBeneath`), counted only where a
    live row still stands (`builtJudge.ts`, `nodeRowMoves.liveAmong`). With
    the folder itself visible, a file beneath it is hidden only where such a
    setting hides it. A hidden empty folder refuses too, which the per-file
    check let through; that is the safer side.
  - Its links follow in the background: one `linkRepairs` entry names the
    moved row and where it was, and each pass turns the next page of the
    files now beneath that row into pairs for the rewrite, moving their link
    facts in the same transaction (`folderLinks.ts`). The row is followed by
    id, so a folder moved again first sends its old links to the newest name.
  - The change log writes nothing. `nodeTrees.folderMoves` counts these moves
    and the feed token carries it, so a device walks after one, as it did
    after a paged move.
  - A trash leaves links where they were, as before, and the search index
    follows the folder itself into the trash.
- A file still read at its path (no key; written by path after keying, such
  as a mail pass's attachment list) refuses a move that would carry it, big
  folder or small, since its bytes would stay behind. A big folder finds
  such files by key rather than by reading itself: there are few, and past
  `UNKEYED_ASKED` of them in the workspace the move refuses.

What a "simplification" would cost: reading every row of a big folder again
brings back a move whose time grows with the folder, which is what the owner
asked to be rid of; judging it by rules without asking which settings still
name a live row refuses moves over names nothing holds.
`apps/convex/__tests__/nodes/builtFolderMove.test.ts` fails for the feed
count dropped, the link entry dropped and the rules check dropped, and checks
that no row beneath the root changes and that links follow a folder moved
twice to its newest name.
