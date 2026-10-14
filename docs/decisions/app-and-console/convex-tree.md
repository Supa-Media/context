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
  - **note text**: bodies, attachments, collaboration history (front matter
    values, a note's first heading and paragraph, and its links joined the
    rows on 2026-10-13 as rebuildable derivatives; see
    [convex-facts](./convex-facts.md));
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

**No reader of which notes exist reads the bucket** (decided by the owner,
2026-10-13: "the only thing that should be reading from storage directly
should be actually opening and editing a note ... I don't want to see even
fallbacks ... everything should be on convex"). This replaces every "else the
bucket" below.

- **The tree answers once its first copy has finished**, whatever its parity
  check says (`treeReadiness` in `lib/nodes/listing.ts`: `served` for a
  `ready` tree, `loading` before, `unsupported` for a store no sweep can
  copy). Parity is a staff alarm: admin › Search › Indexes still shows
  matches and differs, and a difference marks the tree dirty so the next
  sweep repairs it, but it sends no reader anywhere.
- **Pause stops copying, not reading.** Staff's Pause holds the background
  sweeps and the facts fill; readers keep the tree, a console change still
  re-checks the rows it touched, and a folder move made while paused goes
  the one-go way rather than queue behind a worker that is held.
- **"Still loading" is a state, never a bucket read.** The credential
  barrier answers a one-folder `list`, a `source: "tree"` walk,
  `notePaths`, `folderPaths`, `workspaceGraph`, `visiblePaths`,
  `folderNotes` and `chaosScore` from the rows and the rules mirror before it
  decrypts the bucket's credential (`lib/nodes/treeReads.ts`), over a store
  that throws on any other read. Before the first copy has finished each
  answers `TREE_LOADING` and starts the copy; the console shows that line
  until its live root listing lands (`useListings`), and a store that cannot
  be listed in order says so in its own words. A workspace with no bucket
  bound answers `STORAGE_NOT_CONNECTED`, as every operation on it does. The
  gateway's `/gateway/tree/manifest` and `/gateway/tree/facts` answer
  `{ served: false, loading: true }` in the same state, and start the copy.
- **A List reads no note.** Lists and Boards take each note's front matter
  from its facts row: a note saved since it was parsed shows what was last
  parsed until the fill catches up, a note never parsed is listed as a gap
  (`missing`), and the fill is started (`answerFromFacts`). The phone and
  desktop apps' List no longer walks a folder and reads its bodies.
- **The map has no other source.** Its notes are the rows and its links the
  Convex facts; before the facts have read every note the map draws every
  note and says it is behind on links, and never reads the search index's
  docmap. Link completion likewise reads the rows only.
- **The note count keeps its last figure** while the tree cannot answer,
  rather than count the bucket (`recountNotes`).

What stays on the bucket, each for a reason: opening and editing a note; a
website Publish (below); the background work that keeps the tree equal to the
bucket (sweeps, touches, parity, the facts fill, the move worker); the
organizer's read-only passes, which still fall back to the bucket's listing
where the tree does not serve; a folder page's inherited statuses, read by
name from the front notes above it (`serverFrontNotes`); and search.

What a "simplification" would cost: a bucket fallback on any of these
readers is a second answer that can disagree with the tree the rest of the
app draws, and a slow one on exactly the workspaces that are still loading.
What fails if reversed: `apps/convex/__tests__/nodes/treeReads.test.ts`
(every read answers with no bucket bound, a team member gets no private
name, loading answers `TREE_LOADING` and starts the copy, a List never reads
a note), `nodes/nodesListing.test.ts` (parity and Pause change nothing),
`nodes/servedNoteCount.test.ts` (the count opens no bucket),
`apps/mobile/__tests__/treeLoadingNotice.test.ts` and
`apps/mobile/__tests__/serverLists.test.ts`.

**Phase 2, as built (2026-10-12).** The console's sidebar and folder pages
read folders from `nodesListing.listFolder`, a live query, so a change made
anywhere redraws every open tab that shows the folder. Four rules hold it:

- **The tree answers once its first copy has finished.** Until 2026-10-13
  `treeServes` also needed a matching parity check and no Pause, and the
  console read the bucket otherwise; now the query answers `null` only
  while the first copy runs, and the console says "still loading" (above).
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
  the Convex rules (`servedNodesStore`, `lib/nodes/manifestStore.ts`), and
  answers `TREE_LOADING` before the first copy has finished; it never walks
  the bucket or the D1 table.
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

Pins and recents name paths, and follow every move for whoever may see where
it went (phase 4 B2, below).

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
  see, since only a move made in one go knows how to leave that behind. An
  agent's `move_folder` falls back only for a folder of up to 100 objects; a
  larger one the queue declines is refused with the reason (owner,
  2026-10-13). It used to write an old-style logical move job under
  `.context/moves/` instead, which every `read_note`, search and listing then
  had to look through; nothing on the way to a note reads those jobs now. A
  job already in a bucket is still finished by the gateway's background drain
  and `materialize_move`, and `write_note` still refuses a path a draining
  job is copying out of.
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
  is never overwritten (`moveObject`).
- **The worker never stops short and never sticks on one object** (decided
  2026-10-14, project file `move-engine/plan.md`). It walks the old name with
  the store's cursor, because a page of hidden deleted-note markers lists as
  empty while files follow it, and finishes only after a whole walk finds
  nothing left. Each object is retried in place (three tries) and a failure
  leaves it for the next pass while the objects behind it keep moving
  (`moveSteps.ts`). A stranger's object at the destination is kept, and the
  moving one lands beside it as `name (moved).ext`, then `(moved 2)`: the
  conflicted-copy rule sync tools use, so neither is lost. Only where that name
  is exactly as visible as the destination: if either name has a rule of its
  own the object stays put and the move shows as stuck. Reverting to "list
  until empty" or "throw on a clash" fails `__tests__/nodes/moveEngine.test.ts`.
- **A file that is not a note moves by the bucket's own copy** (decided
  2026-10-14, `move-engine/plan.md` step B), so its bytes never pass through
  Convex: one `CopyObject` up to 5 GiB, a multipart `UploadPartCopy` past
  that, every part pinned to the source version it started from, the
  completion only onto nothing, and any failure aborting the upload. A
  multipart copy is stamped `x-amz-meta-context-copy-of: <source etag>` so a
  pass that died before retiring the source recognises its own copy. The
  store reports `serverSideCopy: "same-store"` only where the connect probe
  proved a conditional copy; elsewhere a file over 24 MiB is left in place
  and the move shows "A file is too large to move on this storage" rather
  than overflowing the action. Notes still move by read and write, so their
  history and stamp go with them. A deleted note's marker at the destination
  is a clash like any stranger's object, never a failure for ever. Reading
  the source or dropping the part pin fails `__tests__/nodes/serverCopy.test.ts`.
- **Storage catches up within five hours, and staff hear when it won't**
  (decided 2026-10-14, `move-engine/plan.md` step C). Each pass records its
  pace on the move row, smoothed over passes, and admin › Search › Indexes
  shows each move's time left and one line for the deployment: files still to
  copy, the oldest move's age, and when the slowest bucket catches up. A move
  four hours old, on pace to miss five, or stuck is *late*: a check every 15
  minutes marks it once and mails the staff who turned on "Email me when
  storage falls behind", and its finish mails that it caught up — one mail
  each way per move, at most 12 an hour (`storageLag.ts`). Handles, counts
  and times only. Mailing on every check, or anybody off `ADMIN_EMAILS`,
  fails `__tests__/nodes/storageLag.test.ts`.
- **Opening a note promotes it.** A request's store reads through the pending
  moves (`withPendingMoves`): touching the new name moves that object there
  first, collaboration history included; an old name still holding its object
  reads as it is; a write to an emptied old name is refused.
- **Old names are reserved while a move is pending**, and forward for 30 days
  after, through the existing forwarding ledger.
- **A website scan lists the tree while a move is pending**, and fails as
  incomplete where it cannot; a move drawn, undone or finished that reaches
  the site marks its index stale
  ([websites](../websites.md#a-scan-while-a-folder-move-is-queued-reads-the-trees-names)).
- **Staff can Retry and Undo** in admin › Search › Indexes, on the
  workspace's row under File tree (`nodeMovesAdmin.ts`), path-free like the rest of that page. A failed pass
  backs off from 30 seconds to 15 minutes and retries for ever; it shows as
  stuck after three. Undo turns the same row around, and is refused while a
  pass holds it or a later move depends on its names.

Not yet: the gateway's search, and listings outside phase 5's six tools, read
the bucket's layout until the copy finishes (phase 5's tools list from the
rows, folded through the moves), and the one finishing link rewrite may miss a
step along a chain of moves, which forwarding covers.

**Phase 4 B2: places and the walks inside a move follow the tree** (built
2026-10-13).

- **Pins, "You open most" and Recent follow a move for every member who may
  see where it went** (`lib/placesFollow.ts`). Each place is judged by its own
  new name with `canSee`, at that member's role and named groups, under the
  rules after the move; a place they may not see stays put and stops showing,
  so nobody is handed a name `privacy.md` holds back from them. Rules that do
  not parse move nobody's. This replaces "only the mover's" (2026-09-30),
  which existed because a Convex function could not ask who may see a path;
  the tree's rules mirror now answers that. It runs when a queued move
  activates (under the mirror `activate` just checked) and when it is undone,
  after a move made in one go inside the credential barrier (under the
  bucket's `privacy.md`, read after the move), and after an agent's move,
  which the gateway now names on its tree touch (`moves`).
- **The walks inside an operation list the tree where it serves**
  (`lib/nodes/treeNames.ts`): `isFolder` and `keysUnder` for move, copy and
  delete, and the link rewrite's inventory of every note. That is one query
  per two thousand names instead of one bucket request per thousand, and it is
  also a correction: while a folder is moving, deleting it at its new name
  must reach the files the worker has not copied yet, and only the folded tree
  names them there. The rewrite applies the move's own renames to what the
  tree lists, because the tree may not have heard of the move yet.
- **The gateway's link rewrite takes its inventory from the tree too**
  (`tree/served.js`), and a dry run of `move_folder` answers from it. A real
  `move_folder` that falls back to moving in one go still lists the bucket it
  is about to change: an agent's note written a moment earlier reaches the
  tree about a second later, and a move that listed the tree would leave it
  behind. The tree's facts say which notes point at what moved
  ([convex-facts](./convex-facts.md)). A rewrite too large for one call, or
  one the tree cannot list for yet, is reported as not done and left to
  forwarding; it no longer queues a repair job in the bucket (2026-10-13).
  The background drain of an old job, which has no person's grant to ask the
  tree with, still inventories the bucket a page per pass.

What a "simplification" would cost: retargeting every member's places without
`canSee` hands a member the new name of a folder they may not see; judging
only the moved folder and not each place under it hands them a held-back
note's new path; listing the bucket inside a delete while its folder is moving
lets the worker carry the files the delete missed to the new name.

**Phase 5, agents' listings, as built (2026-10-13).** `orient`'s map and
counts, `list_notes`, `list_contacts`, `list_meetings`, `list_channel_days`
and `evaluate_lists` list from the tree and only from the tree (owner,
2026-10-13: "the only thing that should be reading from storage directly
should be actually opening and editing a note ... I don't want to see even
fallbacks"), and auto-organize's `gather` and `outline` passes list from it
too. The front matter those tools show (a meeting's date and attendees, a
day's account and message count, a contact's name and organization, a List's
columns) is the tree's props of each note (`ask: "props"`,
[convex-facts](./convex-facts.md)), so they open no note; `orient` describes a
folder from its front note's first paragraph the same way. `evaluate_lists`
opens the one note it was asked to evaluate, and `orient` its front page.

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
  to 10,000 keys (it leaves as an HTTP body, so the 8,192-element limit on
  function results does not apply), and the gateway reuses it for every
  listing in the same tool call (`apps/mcp/src/tree/served.js`). A tree
  answer may be up to 16 MB (`TREE_RESPONSE_BYTE_CAP`); every other
  control-plane answer stays under 256 KB. Held to 256 KB, a manifest refused
  every workspace past about three thousand notes, which then listed the
  bucket.
- **Only the six listing tools.** A tool that writes lists the bucket it is
  about to change, and a listing of plumbing (`.context/`) always goes to the
  bucket, because the tree never holds it.
- **A refusal is one shape, and never the bucket instead.** An unknown
  token, a malformed field, a walk that stopped short, rules that do not
  parse, and a failed or slow request all answer `{ served: false }` (the
  same bytes for each). A reader the grant lets in, on a workspace whose first
  copy has not finished, is told `{ served: false, loading: true }` and the
  copy is started; parity and Pause no longer refuse (2026-10-13, above). The
  tool says the workspace is still loading and that `read_note`, `write_note`
  and `search_notes` work meanwhile; a failed, slow or malformed request says
  the list could not be read just now. `orient` still answers, without a map.
  A note the props have not read yet is listed with "(details still
  loading)", and a List leaves it out and says `pending`. The one store that
  lists its bucket is one with no control plane at all (the single-tenant
  token deployment, a self-hosted gateway): there is no tree to ask, so it is
  not a fallback.

A rename or move made in the console re-checks the tree as soon as its bytes
land, before the links pointing at it are repaired (`lib/nodes/landedTouch.ts`),
because that repair can read every note in the workspace; the repair reads a
few notes ahead and re-reads any note it changes just before writing it.

A gateway write reaches the tree through `/gateway/tree/touch`, a second or
so later. An agent that writes a note and lists its folder straight away can
miss it until the touch lands.

**Phase 3, as built (2026-10-13).** The rules in `nodePrivacy` become the
authority when staff turn on **Rules from Convex** in admin › Search ›
Indexes (`nodeMigration.privacyAuthority`), for each workspace whose rules
were read from a `privacy.md` that parsed. A workspace with no file, or a
broken one, keeps the file, so its fail-closed answer (everything private)
stands. The authority moves at one seam, the store, so none of the hundred-odd
readers of `privacy.md` changes (`apps/mcp/src/store/privacyAuthority.js`,
wrapped around the store in the console's credential barrier, the gateway's
session store and the queued move worker):

- **Reading `privacy.md`** answers the bucket file's prose with its managed
  block rendered from the held rules, under their version (`ctx-…`, which no
  bucket etag can equal). A rule edited into the file is never read.
- **Writing it** is a compare-and-swap on that version (`nodesPrivacy.write`),
  and only then is the file written to the bucket as the export. An export
  that fails is owed and retried a minute later (`nodesPrivacyExport`); an
  export that lands after a newer change is written over again. A text whose
  rules will not parse is refused, never stored.
- **A file edited past the rules is put back.** A listing that sees
  `privacy.md` at a version other than the last export owes the export, so
  the rules overwrite it within a sweep. That is sooner than "the next change
  made in the app", and it is the same promise: the file is never the
  authority.
- **Nothing is lost at the flip.** Before it, every successful write of the
  file reports its rules and the version it replaced (`nodesPrivacy.written`);
  after it, a report is kept only as the direct successor of the held
  version, which is a write that began just before the flip.
- **The gateway proves itself per call.** `/gateway/privacy` takes the
  gateway secret and the person's token (or a queued move's ticket while its
  job holds the lease), and acts only on the workspace that proof reaches.
- **The way back** is the same switch, refused while any export is owed, so
  the file it hands back to is current.

**Phase 3 follow-ups (2026-10-13)**, found in an audit before the switch was
first turned on, each with a test in `__tests__/nodes/privacyAuthority.test.ts`
or `apps/mcp/test/privacyAuthority.test.mjs`:

- **The rules' own answer is never mistaken for the file.** A mirror read
  that comes back under a `ctx-` version is the store answering from the held
  rules, so `savePrivacy` drops it rather than storing it as what the bucket
  holds.
- **A copy the file moved past is re-read at once.** When a listing finds
  `privacy.md` past rules nobody decided here (a copy, `rulesAuthoredHere`),
  the file decides again and is read into the mirror straight away, not at
  the next sweep.
- **A storage move takes the rules with it.** Moving a workspace to other
  storage keeps the authority's row and owes an export, so the new bucket
  gets `privacy.md` from the held rules instead of the workspace falling back
  to whatever file the new bucket has.
- **Only a grant that can write the workspace writes its rules.**
  `/gateway/privacy` refuses a token whose role is `member` or whose grant
  lacks `context:write`, even if the gateway asked.
- **A copy is never mistaken for a decision.** Rules reported or read while
  the file is the authority carry no export version, so an owner's edit to
  the file made before the flip, and not yet read, is never written over as
  if the rules had moved past it.
- **A request whose rules were handed back reads the file.** When the swap
  answers that the file is the authority again, the store stops rendering the
  rules it held, so the caller's retry reads and writes the bucket's file.

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
- **The feed answers once the tree serves** (`treeServes`), and Pause no
  longer stops it (2026-10-13). Where it does not reach, the device walks
  the rows, never the bucket.

`nodesFeed.head` is a live query each device subscribes to
(`useNodeFeed.ts`). It moves when a change this reader may hear of lands, or
the rules change, and the device then catches up through `syncTreeChanges`,
which asks `nodesFeed.changes`; where the feed does not reach, the device
walks whole (the D1 table's log is gone, phase 7). A context the feed
reaches gets no five-minute pass; one it does not reach keeps it. A copy fed
this way is walked whole once a day as a backstop. Rows are kept 30 days and leave with the workspace
(`nodesPurge.ts`). The outbox still addresses paths; addressing nodes waits
on phase 4's moves.

**A queued folder move walks the device copy** (2026-10-13). A queued move
renames everything under it without a log row, since the rows stay physical
until the copy lands, so a copy fed only from the log kept the old names (on
Home, Lists and Boards) for as long as the copy ran. The pending `moving` rows
are now part of the version a copy is judged by (`movesMark` in `feedToken`):
a move starting, being undone or finishing moves the head and answers `full`,
and the walk folds the moves in. While a move is pending, the log rows under
either of its ends (the copy's own churn) are passed over, and the walk at
its end settles them. A walk reads that version before its rows, so a move
landing mid-walk leaves the copy on the older version, which walks again.

What fails if reversed: `apps/convex/__tests__/nodes/nodesFeed.test.ts` (a
member never hears of a private change, by name or by cursor; a deleted
private note is never named to a member; rules changes and old cursors walk;
strangers are refused), the log cases in `observe.test.ts`, and
`apps/mobile/__tests__/nodeFeedSync.test.ts` (a moving head is a pass, and
no timed pass while fed).

**Phase 7, part 1, as built (2026-10-13): nothing reads the D1 log or walks
the D1 table.** A device's catch-up asks the Convex feed, and where that does
not reach it walks whole; the `treeChanges` file operation, its D1 reader and
`tree_log` itself are gone (the gateway drops the table on its next touch).
A whole-tree walk the Convex tree does not serve yet answers "still
loading" (2026-10-13; it listed the bucket before). The D1 `tree` table
stayed until part 2.

**Phase 7, part 2, as built (2026-10-13): the D1 tree is gone.** Once the
links, front matter and chaos history had moved onto the Convex rows
([convex-facts](./convex-facts.md)), nothing needed the search database's
copy of the tree. The gateway no longer writes it (`keepTreeTable`, the
projection's tree and link rows) and drops `tree`, `tree_gone`, `tree_log`,
`tree_links`, `tree_link_sources`, `tree_props`, `tree_chaos` and their
`index_state` keys on its next search write (`apps/mcp/src/tree/retired.js`).
The `sweepTree`, `touchTree` and `treeState` file operations, the admin Tree
index screens and their D1 fills are removed; a console change touches the
Convex tree and then tells its audiences (`keepTreeAndAnnounce`,
`lib/filesFns/treeOps.ts`). A reader the Convex tree or its facts cannot
answer yet is told so ("still loading", a List with gaps, a map behind on
links, a score from the keys alone) and never reads the bucket or the
search index instead (2026-10-13, above). A write's chaos report
is counted from the tree's keys before the change and the same keys with the
change applied (`apps/mcp/src/chaos/change.js`); the control plane hears of
the change only after that read, so "before" is never already the change.
What fails if reversed: `apps/convex/__tests__/treeOps.test.ts` (nothing
schedules a D1 operation; the tree is touched before audiences are told), `nodesOperationRouting.test.ts`
(the D1 kinds are refused), `apps/mcp/test/treeRecord.test.mjs` (no tree row
is written and the tables are dropped, never at the cost of the note) and
`chaosChange.test.mjs`.

**The rest of the app's readers, as built (2026-10-13).** Everything in the
app that asks only *which notes exist and where* reads the rows where
the tree has finished its first copy, through the same stores and the same
listing code, and since 2026-10-13 with no bucket fallback (above):

- **A one-folder `list`** (the console's fallback, a shared folder link, a
  share card, the routines scan, an Obsidian plugin's vault listing) is the
  live listing's own answer (`nodesListing.listServed`), given at the
  clearance the barrier already decided, before a bucket credential is
  opened (`lib/nodes/treeReads.ts`).
- **Link completion and quick open** (`notePaths`), **the folder picker**
  (`folderPaths`) and **the map's notes** (`workspaceGraph`) read the rows
  through `servedNodesStore`, which now answers a delimited listing from one
  read of the rows held for the call. The map folds the link table's bucket
  keys through the pending moves, so a moving folder is drawn, links and
  all, at its new name.
- **A folder's Lists and Boards** take the folder's notes and versions from
  the rows and, since 2026-10-13, the front matter from each row too
  ([convex-facts](./convex-facts.md)) (`folderNotesFromNodes`); a facts row
  at another version than the row's serves what was last parsed, and is
  never read again from the bucket. While a move is pending they list the rows at the
  names the tree draws and look each note's front matter up at every key it
  may still sit at (`physicalCandidates`). They used to fall back to the D1
  table, at bucket keys judged by the old names' rules, which kept a folder
  moved somewhere private in team members' Lists until the copy finished
  (fixed 2026-10-13).
- **The chaos score** (the app's figure and folder chip, and orient's chaos
  line) is counted at read time from the rows' keys, pending moves folded
  in, with only what a key cannot say (a note's length, a contact's review)
  read from the properties table and drawn through the same moves
  (`liveChaosScoreOf`, `chaos/live.js`). The team figure counts only what
  the mirror's rules show the team. Before the facts have read every note it
  is counted from the keys alone and not recorded in the daily history. Pinned in
  `__tests__/nodes/servedChaos.test.ts` and `test/chaosLive.test.mjs`.
- **The free plan's note count** ("912 of 1,000 notes", `recountNotes`) is
  the rows' note keys, with no bucket credential opened
  (`lib/nodes/servedCount.ts`, pinned in
  `__tests__/nodes/servedNoteCount.test.ts`); while the tree cannot answer
  the last figure stands. Verifying a newly connected bucket still counts the
  bucket, since no tree exists for it yet.

Two readers deliberately stay on the bucket: **publishing a website**, because
a Publish releases the bucket's bytes and must see a page written past the app
(Obsidian, S3 tools) at once, not at the next sweep; and every **index built
from note text** (search, meaning, the link and props fills), which follows the
bucket's physical objects.

Reviewed again on 2026-10-13, three small listings also stay, each for a
reason rather than by omission: the **connect-time snapshot** an agent is
handed (one delimited listing of the root, which costs less than the tree's
whole-tree manifest would); the **gateway's note cap** inside a write (it
must count what the bucket holds at the moment of the create, and a free
context's count stops at the cap within a page or two); and **search's
literal scan**, the recovery path for an unusable index, which reads note
text at the bucket's physical keys.

**A move of a folder is one row.** Paths are derived from parents, so moving
or renaming a folder changes its own row and nothing beneath it. That is
phase 4. Phase 1 still stores each row's full `path`, because the bucket is
still where moves happen.

**Staff can see it and stop it** (asked for by the owner, 2026-10-12). Admin ›
Search › Indexes has a File tree column and card: each workspace's stage
(not started, copying, copied, matches, differs, stuck, skipped), Pause
copying / Resume copying, and Check all (`functions/nodesMigration.ts`).
Since 2026-10-13 (the owner approved the board) that column also carries the
old Sidebar tree's D1 health, as "Lists, Boards and map details", and the
folder moves still copying; Start all and Fill all went, because
`keepCurrent` copies every due workspace every 15 minutes and a row's Repair
covers the rest. The switch
is one `nodeMigration` row. A pause is obeyed before a sweep or a facts fill
is scheduled and again at the top of every such pass, so a running sweep
stops at its next pass. Since 2026-10-13 it stops nothing else: readers keep
the tree, and a console change still re-checks the rows it touched.

**How the tree stays equal to the bucket, and how we know** (2026-10-13).
Four things write the rows, and one thing decides whether they may be served.

- **A change made through us is re-checked by name.** The console's changes
  before they answer (`touchNodesNow`); the gateway's on `/gateway/tree/touch`
  a second or so after (`treeTouchOf`); email asks for a sweep. A save of a
  note's text alone (`update_note`, encrypt, decrypt) is sent as `edited`,
  gathered on the tree's row for three seconds and re-checked together
  (`nodes.queueEdits`, `flushEdits`), so a burst of typing pauses is one
  listing a note. Until 2026-10-13 nothing sent those saves: a row kept the
  version from its last sweep for up to an hour, so the desktop and phone
  apps, which follow the change log, never heard of a web edit until then.
- **A change made past us** (Obsidian, S3 tools) is found by the sweep: the
  cron starts one wherever a tree is due (dirty, failed, or an hour old), so
  such a change can take up to about 75 minutes to show.
- **Parity is an alarm** (since 2026-10-13; it gated serving before). A
  finished sweep checks again when the tree
  was never checked, when its last check differed, or when its last proof is
  a day old (`nodeParityDue`). A check that finds differences asks once more
  thirty seconds later before it records them, because a write landing
  between its walk of the bucket and its walk of the tree reads as one; a
  difference that stays is recorded for staff and marks the tree dirty, so
  the cron sweeps it and the sweep's check can clear it. Readers keep the
  tree throughout.
- **Where it shows.** Admin › Search › Indexes, the Convex copy card: each
  workspace's stage (matches, differs, stuck, copying), mismatches and when it
  was last checked. Nobody else sees a difference.

**What a "simplification" would cost.**

- Storing visibility on each row makes Convex a second privacy engine that
  goes stale when a rule changes. The rules are kept once, and judged at
  read time.
- Keeping note text beside the names makes Convex a second copy of the
  customer's notes, which ends non-negotiable #1.
- Judging a reader by anything but the rules mirror's `canSee` would show a
  team member a tree the rules never gave them; the parity check is how
  staff learn the mirror or the rows drifted, and the sweep repairs both.
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
  refuses strangers, answers `null` only before the first copy has finished
  (parity and Pause change nothing), and shows each clearance
  what the bucket's listing shows; `inlineTouch.test.ts`: a console change
  updates the tree before it answers; `manifestStore.test.ts`: a walk of the
  rows hands every clearance what a walk of the bucket hands it.
- `apps/convex/__tests__/nodes/servedReaders.test.ts`: one folder, the
  picker, link completion, Lists and the map answer from the rows what they
  answer from the bucket at every clearance, with the tree's rules, and the
  map draws a moving folder's links at its new name.
- `apps/mobile/__tests__/followMoves.test.ts`: the open note follows a move
  made elsewhere, and never this tab's own.
- `apps/convex/__tests__/nodes/privacyAuthority.test.ts`: a change is a
  compare-and-swap, a file written past the rules is put back, the route
  never reaches another workspace, and the switch hands back only a current
  file; `apps/mcp/test/privacyAuthority.test.mjs`: every privacy decision
  reads the held rules, never a rule edited into the file.

- `apps/convex/__tests__/gatewayTreeTouch.test.ts` and
  `apps/mcp/test/treeTouchReporting.test.mjs`: a save of a note's text reaches
  the tree, gathered; `nodes/convexNodes.test.ts` and
  `nodesOperationRouting.test.ts`: a finished sweep re-checks a stale or
  differing proof, and a difference is confirmed before it stops the tree
  serving.
- `apps/convex/__tests__/nodes/nodesMigration.test.ts` and
  `nodesOperationRouting.test.ts`: only staff read or flip the switch, and a
  pause schedules no sweep or fill and stops one before it lists the bucket.
- `apps/convex/__tests__/nodes/queuedMoves.test.ts`: a folder move is one
  row, draws at once at every clearance, carries and releases privacy,
  collapses chains, reserves old names, and Undo/Retry work;
  `movePaths.test.ts` and `moveObject.test.ts`: the fold, promotion, and an
  edit or a stranger's note never lost mid-copy; `organizerTreeChange.test.ts`:
  the organizer's moves reach the tree; `apps/mcp/test/queuedFolderMove.test.mjs`:
  the gateway queues folder moves and reads through them.
- `apps/convex/__tests__/nodes/treeNamesAndPlaces.test.ts` and
  `places.test.ts`: places follow a move only where their person may see the
  new name, place by place, and a delete of a moving folder reaches every file;
  `apps/mcp/test/treeReferenceInventory.test.mjs`: the gateway's link rewrite
  lists the tree with the move applied.
