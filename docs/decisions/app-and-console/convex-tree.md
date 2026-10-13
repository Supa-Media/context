# App and console — the tree moves into the control plane

### A workspace's tree and its privacy rules live in Convex, and the bucket keeps the files

*Decided by the owner, 2026-10-12* ("what would it look like if people's tree
states were based on a table in Convex that updated immediately… I'm fine
with doing this and just like walking back some of the rules and updating the
documentation"; then "let's go").

**Why.** The tree table in each workspace's own database
([tree-table](./tree-table.md)) made the sidebar fast. It did not make the app
agree with itself:

- Convex told an open tab only *that* something changed. Each tab then walked
  the whole tree again and merged that walk with each folder's listing and
  with local edits.
- The open note, Lists and Boards, Home, pins and the map each had their own
  source and their own refresh. A create or rename reached each of them at a
  different moment.
- Every move copied its files before anything on screen changed, and no agent
  tool read the table at all. The audit is
  `tree-efficiency/findings.md` in the project files.

A tree that changes first, that every screen reads live, and that has files
catching up behind it, is what the product sells ("less chaos"). Convex
already gives live queries and transactions. Building the same thing on the
per-workspace database would have meant writing both ourselves.

**What moves, and what never does.**

- **Into the control plane:**
  - one row per file and folder: its path, its parent, its version and size;
  - each workspace's privacy rules, parsed;
  - from phase 4, where each file physically sits while its move is pending.

  Those are names and metadata.
- **Never into the control plane:**
  - **note text**: bodies, front matter values, attachments, collaboration
    history;
  - the search indexes, which are built from note text.

  These stay in the customer's bucket and in the per-workspace database. That
  line is what keeps non-negotiable #1's exit promise, managed encryption, and
  a workspace that outlives our credential. A Convex document's size limit
  would have refused note text anyway.
- **The bucket stays canonical.** The rows are rebuilt from a listing of it
  (`apps/convex/functions/lib/nodes/sweep.ts`). Each change re-checks what it
  touched (`touch.ts`). A sweep repairs anything written past us, such as
  Obsidian, S3 tools or the email worker. Deleting every row loses nothing.
- **Who may see a row is never stored on it.** It is decided when served, by
  the same `canSee` over the workspace's rules.
- **Names leave with the workspace.** Deleting a workspace, or disconnecting
  a customer's own bucket, deletes its rows.

**`privacy.md` becomes an export** (phase 3). Convex holds the rules. Every
change renders `privacy.md` in the same format and the same markers, and
writes it to the bucket root, so a customer who leaves, or revokes us on the
free plan, still holds who-sees-what. It is never read back as the authority.
An edit made to it outside the app is overwritten by the next change made in
the app; it is read once more only to import a workspace. Self-hosting loses
nothing: the gateway has needed the control plane since the shared-token
mode was removed (`apps/mcp/src/index.js`).

**How it rolls out.** Each phase merges green on its own, and each can be
rolled back by reading the old way, because the bucket stays the files' truth.

1. **Shadow.** The tables `nodes`, `nodeTrees` and `nodePrivacy`
   (`lib/schema/nodes.ts`) are filled by sweeps and kept current by
   re-checking every change:
   - console changes, through `keepTreeAndAnnounce`;
   - gateway changes, through `/gateway/tree/touch`;
   - email captures, which ask for a sweep.

   Nothing answers a person from them. A parity check
   (`lib/nodes/parity.ts`) holds the tree they describe equal to the bucket's
   at owner, team and named clearances, and staff see the result in
   admin › Search › Tree index.
2. The app reads the tree live from Convex: sidebar, folder page, Home, pins
   and the open note's identity. The tab walks and tree hints are retired.
3. Privacy authority moves to Convex, and `privacy.md` becomes the export.
4. Moves are written to the tree first and copied behind, through a move
   queue on Convex scheduled jobs. Opening a note follows it to wherever it
   is.
5. Agents' tools read the tree.
6. The desktop and phone apps sync from a change log, and their outbox
   addresses nodes rather than paths.
7. The D1 tree table, its change log and the duplicated gateway file
   operations are removed.

**Phase 2, as built (2026-10-12).** The console's sidebar and folder pages
read folders from `nodesListing.listFolder`, a live query, so a change made
anywhere redraws every open tab that shows the folder. Four rules hold it:

- **The tree answers only where it is proved.** `treeServes`
  (`lib/nodes/listing.ts`) answers for a workspace whose last parity check
  matched at every clearance and whose last pass did not fail. Anywhere else,
  and for everybody while staff have paused the migration, the query answers
  `null` and the console reads the bucket exactly as before. Pause is
  therefore the way back for every reader at once. A tree's first finished
  copy is checked automatically, so new workspaces join on their own.
- **Privacy is not reimplemented.** The rows and the rules mirror are handed
  to the unchanged `listFolder` as a store, so `canSee`, the folder test and
  "a withheld folder answers as an absent one" are the same code the bucket
  listing runs.
- **A console change updates the tree before it answers.** The re-check
  that phase 1 scheduled now runs inside the change (`touchNodesNow`), and a
  change that rewrote `privacy.md` re-reads the rules too. The tab that made
  the change never reads the tree from before it. Changes from the gateway
  and email still re-check on a scheduled job, a second or so later.
- **A folder is drawn only while something is in it**, as in a bucket
  listing: a tombstone that leaves a folder empty marks the folder gone, up
  the chain, and a file observed in it brings it back
  (`retireEmptyFolders`, `reviveChain` in `observe.ts`).

The rest of phase 2 (2026-10-13):

- **The whole-tree walk reads the same rows.** A `source: "tree"` manifest
  (the browser tab's walk, which draws Home, pins, recents and the quick
  switcher, and the desktop and phone apps' sync) pages the Convex rows with
  the Convex rules wherever `treeServes` holds (`servedNodesStore`,
  `lib/nodes/manifestStore.ts`), before the D1 table or the bucket is asked.
  The unchanged `syncManifest` still decides who sees what. A tab the tree
  serves walks again on a tree hint, at most every ten seconds, because that
  walk is now a few queries and the folders on screen are already live.
- **Pins, You open most and Recent are subscriptions** (`useHomePlaces`), so
  a pin made on the phone reaches an open Home on the desktop at once.
- **The open note follows a move made anywhere.** When the note leaves its
  folder's live listing, it is read again at its old name; the read follows
  the forwarding ledger, and the editor goes on to the new name with what it
  holds, as for a rename made in the same tab (`useFollowMoves.ts`). A note
  that was deleted, or moved out of reach, says so and stays on screen.

Pins and recents still name paths, so a move made by somebody else drops
them from Home until they are retargeted (phase 4's follow-up, B2).

**A move of a folder is one row** (phase 4, built 2026-10-13). Moving a folder
of any size writes one `moveQueue` row and answers; every screen draws the
folder at its new name at once, and the bucket catches up behind it.

- **The node rows stay physical.** A row's `path` is still where the file
  sits in the bucket. The tree as drawn is the rows folded through the
  workspace's pending moves, oldest first (`lib/nodes/moveOverlay.ts`,
  `logicalPath` / `physicalCandidates` in `apps/mcp/src/moves/queued.js`).
  Rewriting every row under a folder would make a big move many mutations
  and a half-finished one a broken tree; the fold makes it atomic.
- **Only folders queue.** A single note still moves in one go. A folder move
  falls back to the one-go move when the tree does not serve, when another
  move is being set up, or when the folder holds anything the mover cannot
  see, since only a move made in one go knows how to leave that behind.
- **Privacy is carried, never stored on a row.** The start copies the source's
  rules to the new name in `privacy.md` and narrows the destination, exactly as
  a one-go move would (`movePrivacy.ts`); the old name's rules go when the copy
  finishes, and an undone move takes back what it added, restoring what it
  narrowed. The start only activates if the mirror still matches what it read.
- **The worker copies straight to where the tree draws a file now**, through
  every pending move, so a move made on top of a moving folder copies each
  object once (chains collapse). One pass works for a minute, a pool of six
  at a time, reports what moved, and schedules the next (`moveWork.ts`). An
  edit landing mid-copy keeps the edit and retries; a name taken by a stranger
  is a conflict, never an overwrite (`moveObject`).
- **Opening a note promotes it.** A request's store reads through the pending
  moves (`withPendingMoves`): touching the new name moves that object there
  first, collaboration history included; an old name still holding its object
  reads as it is; a write to an emptied old name is refused.
- **Old names are reserved while a move is pending**, and forward for 30 days
  after, through the existing forwarding ledger.
- **Staff can Retry and Undo** in admin › Search › Indexes, Moves
  (`nodeMovesAdmin.ts`), path-free like the rest of that page. A failed pass
  backs off from 30 seconds to 15 minutes and retries for ever; it shows as
  stuck after three. Undo turns the same row around, and is refused while a
  pass holds it or a later move depends on its names.

Not yet: the gateway's search, and listings outside phase 5's six tools, read
the bucket's layout until the copy finishes (phase 5's tools list from the
rows, folded through the moves), and the one finishing link rewrite may miss a
step along a chain of moves, which forwarding covers.

**Phase 5, agents' listings, as built (2026-10-13).** `orient`'s map and
counts, `list_notes`, `list_contacts`, `list_meetings`, `list_channel_days`
and `evaluate_lists` list from the tree wherever `treeServes` holds, and
auto-organize's `gather` and `outline` passes do too. Note text is still
read from the bucket.

- **The gateway asks `/gateway/tree/manifest`** (`lib/nodes/gatewayManifest.ts`)
  with the person's own access token, as `/gateway/site` does. The workspace
  is chosen from that grant's set, and the clearance is the gateway's own
  rule read off the grant: `private` only for an owner whose grant carries
  `context:private`. No request field names a scope.
- **Privacy is decided twice, never once less.** The route hands the rows
  and the rules mirror to the unchanged `syncManifest`, and the tools then
  filter with `canSee` over the bucket's `privacy.md`, as they filtered the
  bucket's listing. A key reaches an agent only if both agree.
- **One request per call, not one walk per folder.** An answer carries up
  to 20,000 keys (it leaves as an HTTP body, so the 8,192-element limit on
  function results does not apply), and the gateway reuses it for every
  listing in the same tool call (`apps/mcp/src/tree/served.js`).
- **Only the six listing tools.** A tool that writes lists the bucket it is
  about to change, and a listing of plumbing (`.context/`) always goes to the
  bucket, because the tree never holds it.
- **Anything short of a proved tree reads the bucket.** A tree that is not
  served, staff's Pause, an unknown token, a malformed field, a walk that
  stopped short, rules that do not parse, and a failed or slow request all
  answer `{ served: false }` (the same bytes for each). The gateway then
  lists the bucket for the rest of the call.

A gateway write reaches the tree through `/gateway/tree/touch`, a second or
so later. An agent that writes a note and lists its folder straight away can
miss it until the touch lands.

**Phase 6, as built (2026-10-13): the device copy follows a change log.**
The desktop and phone apps used to walk the whole tree every five minutes.
Now `nodeLog` (`lib/schema/nodes.ts`) holds one row per file that appeared,
changed version or left, written in the same mutation that changed the row
(`observe.ts` through `convexTable.ts`). A sweep that only re-sees a file
writes nothing. Four rules hold it:

- **`seq` follows commit order and starts from the clock** (`log.ts`
  `nextSeq`). Each append reads the workspace's last row, so two appends
  conflict and commit one after the other. Starting from the clock keeps
  `seq` rising after a purge, so a device's old cursor can never land inside
  a new log.
- **A reader is told only what they could see.** A file that is there is
  judged by `canSee` over the rules, as a walk judges it. A file that left
  is told only to the audiences recorded when it left, by the rules as they
  stood then, as `tree_log` does, because today's rules forgot the exception
  that held a deleted private note back. Any change to the rules answers
  `full`, and the device walks.
- **A cursor never names a change the reader could not see.** A catch-up
  that read everything resumes a minute behind the clock (`NODE_LOG_OVERLAP_MS`),
  or after the last row this reader was told about. A team reader is never
  handed the `seq` of somebody else's private change, which would say when it
  happened. A page full of changes they cannot see sends them to walk.
- **The feed answers only where the tree serves** (`treeServes`). Pause in
  admin stops it with everything else, and devices walk as before.

`nodesFeed.head` is a live query each device subscribes to
(`useNodeFeed.ts`). It moves when a change this reader may hear of lands, or
the rules change, and the device then catches up through `syncTreeChanges`,
which asks `nodesFeed.changes` before the D1 table's log. A context the feed
reaches gets no five-minute pass; one it does not reach keeps it. A copy fed
this way is walked whole once a day as a backstop, where the D1 log's copies
are walked hourly. Rows are kept 30 days and leave with the workspace
(`nodesPurge.ts`). The outbox still addresses paths; addressing nodes waits
on phase 4's moves.

What fails if reversed: `apps/convex/__tests__/nodes/nodesFeed.test.ts` (a
member never hears of a private change, by name or by cursor; a deleted
private note is never named to a member; rules changes and old cursors walk;
strangers are refused), the log cases in `observe.test.ts`, and
`apps/mobile/__tests__/nodeFeedSync.test.ts` (a moving head is a pass, and
no timed pass while fed).

**The rest of the app's readers, as built (2026-10-13).** Everything in the
app that asks only *which notes exist and where* reads the rows where
`treeServes` holds, through the same stores and the same listing code:

- **A one-folder `list`** (the console's fallback, a shared folder link, a
  share card, the routines scan, an Obsidian plugin's vault listing) is the
  live listing's own answer (`nodesListing.listServed`), given at the
  clearance the barrier already decided, before a bucket credential is
  opened (`lib/nodes/servedReads.ts`).
- **Link completion and quick open** (`notePaths`), **the folder picker**
  (`folderPaths`) and **the map's notes** (`workspaceGraph`) read the rows
  through `servedNodesStore`, which now answers a delimited listing from one
  read of the rows held for the call. The map folds the link table's bucket
  keys through the pending moves, so a moving folder is drawn, links and
  all, at its new name.
- **A folder's Lists and Boards** take the folder's notes and versions from
  the rows and only the front matter from the workspace's database
  (`folderNotesFromNodes`); a props row at another version than the row's is
  read again, as before. While a move is pending they read the table as
  before, since a note's front matter is still filed under its old key.
- **The chaos score** (the app's figure and folder chip, and orient's chaos
  line) is counted at read time from the rows' keys, pending moves folded
  in, with only what a key cannot say (a note's length, a contact's review)
  read from the properties table and drawn through the same moves
  (`liveChaosScoreOf`, `chaos/live.js`). The team figure counts only what
  the mirror's rules show the team. The `tree_chaos` aggregates stay for the
  daily history and as the fallback. Pinned in
  `__tests__/nodes/servedChaos.test.ts` and `test/chaosLive.test.mjs`.

Two readers deliberately stay on the bucket: **publishing a website**, because
a Publish releases the bucket's bytes and must see a page written past the app
(Obsidian, S3 tools) at once, not at the next sweep; and every **index built
from note text** (search, meaning, the link and props fills), which follows the
bucket's physical objects.

**A move of a folder is one row.** Paths are derived from parents, so moving
or renaming a folder changes its own row and nothing beneath it. That is
phase 4. Phase 1 still stores each row's full `path`, because the bucket is
still where moves happen.

**Staff can see it and stop it** (asked for by the owner, 2026-10-12). Admin ›
Search › Indexes has a Convex copy column and card: each workspace's stage
(not started, copying, copied, matches, differs, stuck, skipped), Pause /
Resume, Start all and Check all (`functions/nodesMigration.ts`). The switch
is one `nodeMigration` row. A pause is obeyed before anything is scheduled and
again at the top of every scheduled pass, so a running sweep stops at its
next pass, and a change made while paused marks the tree dirty for the resume
to catch up.

**What a "simplification" would cost.**

- Storing visibility on each row makes Convex a second privacy engine that
  goes stale when a rule changes. The rules are kept once, and judged at
  read time.
- Keeping note text beside the names makes Convex a second copy of the
  customer's notes, which ends non-negotiable #1.
- Serving the rows before the parity check holds at every clearance would
  show a team member a tree the bucket's rules never gave them.
- Rewriting each row under a moved folder instead of folding the queue makes
  a big move slow and a half-done one a tree that is neither old nor new.
- Moving a folder that holds notes the mover cannot see through the queue
  would carry them along under the mover's name; it falls back instead.
- Dropping the old-name reservation lets a new note land where the worker is
  about to copy from, and be carried off with the move.

What fails if reversed:

- `apps/convex/__tests__/nodes/parity.test.ts`: the tree from the rows equals
  the bucket's at every clearance, and sabotaged rows are caught.
- `apps/convex/__tests__/nodes/observe.test.ts`: an older observation never
  overwrites a newer one.
- `apps/convex/__tests__/nodes/convexNodes.test.ts`: one workspace never
  reads or changes another's rows.
- `apps/convex/__tests__/nodes/gatewayManifest.test.ts`: the gateway reads at
  the grant's clearance in the grant's own contexts, and every refusal is the
  bytes of a tree that does not serve.
- `apps/mcp/test/treeServed.test.mjs`: each listing tool answers as the
  bucket does at owner and team clearance without listing a note folder, and
  a key the tree wrongly sends is still held back.
- `apps/convex/__tests__/nodes/nodesListing.test.ts`: the live listing
  refuses strangers, answers `null` unless proved, and shows each clearance
  what the bucket's listing shows; `inlineTouch.test.ts`: a console change
  updates the tree before it answers; `manifestStore.test.ts`: a walk of the
  rows hands every clearance what a walk of the bucket hands it.
- `apps/convex/__tests__/nodes/servedReaders.test.ts`: one folder, the
  picker, link completion, Lists and the map answer from the rows what they
  answer from the bucket at every clearance, with the tree's rules, and the
  map draws a moving folder's links at its new name.
- `apps/mobile/__tests__/followMoves.test.ts`: the open note follows a move
  made elsewhere, and never this tab's own.
- `apps/convex/__tests__/nodes/nodesMigration.test.ts` and
  `nodesOperationRouting.test.ts`: only staff read or flip the switch, and a
  pause schedules nothing and stops a pass before it lists the bucket.
- `apps/convex/__tests__/nodes/queuedMoves.test.ts`: a folder move is one
  row, draws at once at every clearance, carries and releases privacy,
  collapses chains, reserves old names, and Undo/Retry work;
  `movePaths.test.ts` and `moveObject.test.ts`: the fold, promotion, and an
  edit or a stranger's note never lost mid-copy; `organizerTreeChange.test.ts`:
  the organizer's moves reach the tree; `apps/mcp/test/queuedFolderMove.test.mjs`:
  the gateway queues folder moves and reads through them.
