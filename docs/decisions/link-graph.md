# Link graph

_See `docs/decisions/README.md` for the index. The design is
`docs/design/link-graph/README.md` (owner decisions) and
`docs/design/link-graph/PLAN.md`; the per-task rulings are in
`docs/design/link-graph/TASKS.md`. The code is `apps/mcp/src/graph/`._

### The reference index is approved, and it is a derivative that is never the authority

Context used to keep no reference index. `apps/mcp/src/forwarding.js` argued
that a second copy of every link would drift from files that Obsidian and
`rclone` also write, and that a stale reference is worse than none. The owner
approved reversing that (decision O1), on conditions. The conditions are the
decision; a tidy-up that drops one of them restores the failure the old
position was written to prevent.

The owner's three conditions (O1, `docs/design/link-graph/README.md`, Owner
decisions):

- **It is a rebuildable derivative under `.context/graph/v1/`.** Nothing in it
  is the only copy of anything. The links stay in the notes, and deleting the
  directory costs a rebuild and nothing else.
- **Every relationship is validated against the source's current version before
  it is returned.** A posting entry carries the `referenceSetVersion` of the
  record that wrote it, and `validateEntry` drops an entry whose source is
  missing, unparseable, excluded, or has since moved on to a different
  reference set. A delayed older write cannot make a removed link reappear.
- **It is never the authority for a canonical edit.** A later feature may use
  the graph to find candidate referrers. It must re-read the source and edit
  from the source, never from the index.

### How it is built (architecture and controller rulings, reversible at review)

These follow from the conditions but are not themselves owner decisions. Each
names its source, so a reader can tell what needs the owner and what needs only
a reviewer.

- **Graph code touches nothing outside `.context/graph/`** (architecture 2.2).
  Reconciliation never writes or deletes the forwarding ledger or any other
  `.context/` object. The rebuild (`rebuild.js`) is bound by the same rule:
  garbage collection deletes only the collected generation's own
  `g/<gen>/` prefix, never the serving, building or retained one, and only on
  a store with `conditionalDelete` (controller ruling OPEN-22).
- **Reads are filtered by `canSee`, per source, before validation**
  (architecture, same rule as the search index). A source the caller cannot
  see never appears and never reaches `validate`, because a posting page holds
  paths of private notes.
- **Encrypted notes are excluded entirely** (architecture 7.6; controller
  ruling OPEN-18). An encrypted body yields `coverage: "excluded"`, no
  occurrences, and no memberships, not even a bare-name entry.
- **The graph is bucket native and its health is stated, never assumed** (PLAN
  decision P4; controller ruling OPEN-10 and OPEN-13). On a store without
  conditional write and conditional create the graph still runs, with
  unconditional writes, but `graphHealth` labels it `possiblyIncomplete` and
  never `complete`, even after a clean sweep.
- **Graph work never affects a write** (PLAN decision P5; controller ruling
  OPEN-12 and OPEN-19). It runs behind the response where the store can defer,
  spends a per-write storage budget (`WRITE_ENRICH_SUBREQUEST_BUDGET`, 0 turns
  it off), and any failure is swallowed. It never changes a write's result or
  body.
- **Moves and archive are left to reconciliation** (controller ruling
  OPEN-20). They go through `recordChange`, which has no body, so the write
  hook does not run for them. The same holds for referrers that a move
  rewrote and for form responses. Reconciliation shares the maintenance
  invocation with search, runs only when `GRAPH_PASS_FLOOR` budget is left
  after the search sync (controller ruling OPEN-21), and never changes the
  search sync's results or budget use.
- **A path leaves the graph only after a direct read of the note returns
  not-found** (controller ruling OPEN-15). That read is triggered either by a
  complete census that omits the path, or by a removal hint from the search
  sync, which works on an incomplete census too. An incomplete census on its
  own removes nothing.
- **Rollback ceiling: health stays behind while a newer build is unfinished**
  (controller ruling, Task 11 fix round 3; an owner decision point). Code older
  than a started build's resolver label keeps reconciling the active
  generation, so repair continues underneath, but it never builds into, cuts
  over or abandons that build, and it publishes the active generation's health
  as `behind`. After a rollback below that label, `graphHealth` therefore stays
  `behind` with `complete: false` until newer code is redeployed and finishes
  the build. There is deliberately no auto-abandon: older code cannot tell a
  rolled-back build from one a newer worker is still running. The test is
  `graphRebuild.test.mjs`, "older code during a newer build reconciles the
  active generation but never publishes it complete".

**What reversing it costs.** Phase 3 backlinks, related notes, and
index-assisted move repair all read this index; they cannot be built on a
reference index that is not allowed to exist. Reversing the conditions while
keeping the index is the more expensive mistake: unvalidated postings return
stale backlinks, an index treated as authority rewrites notes from stale data,
and an unfiltered posting read leaks the existence of private notes.

**The tests that fail if it is reversed.** All under `apps/mcp/test/`:

- Validation against the current record: `graphProject.test.mjs`,
  "validateEntry rejects an older delayed membership write after a newer
  projection" and "validateEntry rejects a missing, unparseable or excluded
  source and reports a budget stop"; `graphPostings.test.mjs`, "readPostings:
  validate drops stale referenceSetVersion; a throw marks incomplete".
- Privacy: `graphPostings.test.mjs`, "readPostings: a source canSee rejects
  never appears and never reaches validate".
- Disposable and confined to its prefix: `graphReconcile.test.mjs`, "nothing
  outside .context/graph/ is ever written or deleted"; `graphRecords.test.mjs`,
  "every key keys.js produces is plumbing and never indexable" and "key
  builders throw on bad segments and never leave the graph prefix";
  `graphRebuild.test.mjs`, "GC after the second cutover deletes only g/<old>/
  in bounded pages and nothing else" and "nothing outside .context/graph/ is
  written or deleted through a rebuild, two cutovers and GC".
- Encrypted notes excluded: `graphFacts.test.mjs`, "encrypted body is excluded
  with no memberships at all"; `graphProject.test.mjs`, "an edit to encrypted
  removes every prior membership"; `graphReconcile.test.mjs`, "an encrypted
  note in the census yields an excluded node with no memberships".
- P4 stores are labelled possibly incomplete: `graphManifest.test.mjs`,
  "best-effort store is always possiblyIncomplete and never complete, even
  after a complete sweep" and "a manifest written in conditional mode read by
  a best-effort store is labelled best-effort"; `graphPostings.test.mjs`,
  "graphMode is conditional only with both probed flags".
- Graph work never affects a write, and is budgeted: `graphWrite.test.mjs`,
  "budget 0: write result and body identical, no graph store op at all", "a
  graph store that throws on put or get never changes the write", and "total
  graph ops never exceed the budget, at any budget"; `graphReconcile.test.mjs`,
  "maintainNow: a graph failure does not reach the caller" and "maintainNow:
  the search sync's results and budget use are unchanged when graph work runs".
- Moves and archive are left to reconciliation: `graphWrite.test.mjs`, "moves
  and archive do not call the hook (left to reconciliation)".
- Deletion needs a direct not-found: `graphReconcile.test.mjs`, "a path absent
  from a complete census but present in the bucket is never removed",
  "removedHints are confirmed by a direct read before removal" and "an
  incomplete census never removes anything".
