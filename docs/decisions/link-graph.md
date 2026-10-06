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

- **It is a rebuildable derivative under `.context/graph/v1/`.** Nothing in it
  is the only copy of anything. The links stay in the notes. Deleting the
  directory costs a rebuild and nothing else, and no graph code may write or
  delete outside the graph prefix (the forwarding ledger and every other
  `.context/` object are never touched, and a graph rebuild never deletes the
  ledger).
- **Every relationship is validated against the source's current forward
  record before it is returned.** A posting entry carries the
  `referenceSetVersion` of the record that wrote it, and `validateEntry`
  drops an entry whose source is missing, unparseable, excluded, or has since
  moved on to a different reference set. A delayed older write cannot make a
  removed link reappear.
- **It is never the authority for a canonical edit.** A later feature may use
  the graph to find candidate referrers. It must re-read the source and edit
  from the source, never from the index.
- **Reads are filtered by `canSee`, per source, before validation.** A source
  the caller cannot see never appears and never reaches `validate`. A posting
  page holds paths of private notes, so the graph is subject to the same rule
  as the search index.
- **Encrypted notes are excluded entirely.** An encrypted body yields
  `coverage: "excluded"`, no occurrences, and no memberships (not even a
  bare-name entry). No hidden contents are inferred.
- **The graph is bucket native and its health is stated, never assumed.** The
  manifest, forward records and postings live in the customer's bucket. On a
  store without conditional write and conditional create (the P4 behaviour)
  the graph still runs, with unconditional writes, but `graphHealth` labels it
  `possiblyIncomplete` and never `complete`, even after a clean sweep.
- **Graph work never affects a write.** It runs behind the response where the
  store can defer, spends a per-write storage budget
  (`WRITE_ENRICH_SUBREQUEST_BUDGET`, 0 turns it off), and any failure is
  swallowed. It never changes a write's result or body, and it is never a
  reason a write fails.
- **Moves and archive are left to reconciliation.** They go through
  `recordChange`, which has no body, so the write hook does not run for them.
  The same holds for referrers that a move rewrote and for form responses:
  the reconciliation sweep, not the write path, brings the graph up to date
  with them. Reconciliation shares the maintenance invocation with search,
  runs only when `GRAPH_PASS_FLOOR` budget is left after the search sync, and
  never changes the search sync's results or budget use.
- **Deletion is confirmed twice.** A path leaves the graph only after a
  complete census omits it and a direct read of the note returns not-found.
  An incomplete census removes nothing.

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
  builders throw on bad segments and never leave the graph prefix".
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
- Deletion needs a complete census and a direct not-found: `graphReconcile.test.mjs`,
  "a path absent from a complete census but present in the bucket is never
  removed" and "an incomplete census never removes anything".
