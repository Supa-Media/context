# Release communication

## The public devlog is the proposed canonical source; plans and code history are inputs

The proposed user-facing source is the `website/devlog.md` note in the public
Context.LC workspace. This matches the existing page and Claude's communication
artifact, but still needs Seyi's approval. If approved, its version history is
the record of what was published. The Supa project workspace remains the
planning source, and this repository's history remains implementation evidence.
Neither is another public roadmap.

This split matters because all three contain different truths. A project may be
worth exploring without being scheduled. A pull request may be merged to
`main` while it is only on staging. A production change may be too small or too
internal for the weekly update. Turning any one of those inputs directly into
public prose would make the automation the product owner.

The evidence workflow does not depend on this approval and does not read or
write the devlog.

**What a simplification would cost:** keeping a second roadmap file in this
repository creates two pages whose ordering and states drift. Generating the
public page from active projects turns exploration into a promise. Generating
it from `main` calls staging work shipped.

## Production evidence is automatic; publication is a review decision

`release-communication-evidence.yml` follows a successful manual `Deploy to
Production` run. It verifies that exact run through the Actions API, finds the
preceding successful production run, proves the two commits are in one ancestry
line, and retains the first-parent interval plus the run's jobs as a JSON
artifact for 90 days.

The workflow has read-only repository and Actions permissions. It does not edit
a note, choose highlights, assign roadmap states, create a GitHub Release, or
post to a community channel. Its artifact says that publication did not occur.
The human-written update may use the artifact as evidence, but somebody still
decides what belongs in the update and approves the words.

**What a simplification would cost:** treating any merge as release evidence
skips the staging/production boundary. Treating a successful run as permission
to publish collapses evidence and communication into one irreversible step.

**The test that fails if this is reversed:**
`scripts/release-communication-evidence.test.mjs` rejects non-production,
failed, automatic, non-`main`, and malformed runs; it also checks that the
workflow has no write permission or release/deploy command.

## GitHub Release synchronization is downstream and remains off

If GitHub Releases later become another reading surface, synchronization must
consume the exact approved public update, not reconstruct one from commits or
project status. The first implementation must be draft-only, record the source
note version and content digest, and be idempotent for that version. Publishing
the draft is a separate explicit action.

That path is deliberately not built before the communication format is
approved. The evidence artifact is the minimum useful automation that does not
pre-empt the format or create a commitment.
