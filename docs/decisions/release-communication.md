# Release communication

## The public devlog is the canonical source; plans and code history are inputs

_Decided by the owner, 2026-09-29_, approving the weekly update artboard with
its recommended answers. The user-facing source is the `website/devlog.md`
note in the pinned Context.LC workspace, published at context.lc/devlog; its
version history is the record of what was published. The Supa project
workspace remains the planning source, and this repository's history remains
implementation evidence. Neither is another public roadmap.

This split matters because all three contain different truths. A project may be
worth exploring without being scheduled. A pull request may be merged to
`main` while it is only on staging. A production change may be too small or too
internal for the weekly update. Turning any one of those inputs directly into
public prose would make the automation the product owner.

The evidence workflow does not read or write the devlog.

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

## Each week has four sections, and exploring is never a promise

A week is a `### week N` heading, an italic date line, and four `####`
sections in this order: shipped, in progress, exploring, declined. Shipped is
live for everyone; in progress is what somebody is building this week;
exploring carries the line "ideas, not promises. some of these won't happen."
and every item starts "looking at:"; declined says why and what to do
instead. The newest week replaces the old "top of mind" list, and weeks
written before the sections keep their single list. The voice is the
owner's: lowercase on the page.

`packages/shared/src/devlog.ts` is the one parser every surface reads a week
through. `devlogPromiseProblems` turns an exploring line with a date or a
promise word ("will", "soon", "coming", a month, a quarter, a year) into a
page problem, and a page problem holds the whole website release, the same
way a broken page does. The rule is enforced at Publish, not in the prose of
this file, because the draft and the owner both write the page.

**What a simplification would cost:** checking only the Discord or GitHub
copy lets the promise go live on the page and in the app, which is where
early adopters read it. Dropping the "looking at:" rule makes an idea read as
an announcement once it is quoted out of context.

**The test that fails if this is reversed:** `apps/convex/__tests__/devlog.test.ts`
("a promise makes the devlog page a problem, which holds the release").

## What's new reads the published page and remembers only a number

The app's What's new row reads the pinned site's published devlog through the
existing public site snapshot and draws the newest week. The control plane
keeps one row per person, `devlogReads`, holding the newest week number they
opened, so the unread dot clears on every device at once. It never moves
backwards and is deleted with the account. No week's words are copied into
the control plane.

**What a simplification would cost:** keeping the read state only on the
device brings the dot back on every new browser; copying the week into
Convex creates a second copy of the page that can disagree with it.

**The test that fails if this is reversed:** `apps/convex/__tests__/devlog.test.ts`
("the reader's place").
