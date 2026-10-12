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

Still to come in phase 2: Home, pins, recents and the open note's identity.
The device copy and the tree hint stay for offline, and a tab the tree
serves no longer walks the bucket on a hint.

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

What fails if reversed:

- `apps/convex/__tests__/nodes/parity.test.ts`: the tree from the rows equals
  the bucket's at every clearance, and sabotaged rows are caught.
- `apps/convex/__tests__/nodes/observe.test.ts`: an older observation never
  overwrites a newer one.
- `apps/convex/__tests__/nodes/convexNodes.test.ts`: one workspace never
  reads or changes another's rows.
- `apps/convex/__tests__/nodes/nodesListing.test.ts`: the live listing
  refuses strangers, answers `null` unless proved, and shows each clearance
  what the bucket's listing shows; `inlineTouch.test.ts`: a console change
  updates the tree before it answers.
- `apps/convex/__tests__/nodes/nodesMigration.test.ts` and
  `nodesOperationRouting.test.ts`: only staff read or flip the switch, and a
  pause schedules nothing and stops a pass before it lists the bucket.
