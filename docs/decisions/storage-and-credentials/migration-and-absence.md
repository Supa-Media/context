# Storage and credentials — migration and absence

## The migration's outcome is recorded, because an offer nobody can answer is a nag

The storage-layout migration has always kept its own state in the bucket:
`migrateStorageLayout` persists it under `.context/` and short-circuits on
`complete`, so running it twice is a no-op. Nothing outside the bucket could
read it. A Convex query cannot open somebody's storage, so the console had no
way to tell **"this bucket still needs the update"** from **"it ran last
week"** — "the owner may run it" was as close to "pending" as it could get.

So the console's offer was answered by a flag on the device: `localStorage`,
per browser, per context. Run the migration on a laptop and the phone offered
it again. Clear site data and the laptop did too. Run it from Settings →
Storage — where the notice's own text sends people — and nothing was recorded
at all. The owner who reported it had pressed the button "so many times", on a
context that was already migrated, and every press was correct behaviour.

`storageBindings.storageLayoutState` is that outcome, written by
`recordStorageLayoutState` on **every** pass of the chain and on the
`unsupported` refusal, which never reaches the chain at all. It is the same
category as `scaffolded` and `noteCount`: something we observed while holding a
credential, which a query cannot recompute without becoming a public function
that opens one. The bucket stays authoritative; this is a copy that travels
with the workspace instead of with the device.

**Absent is a state, and it is the only one that still offers.** It means
nobody has run this through us. The other six are answers: `copying` and
`cleaning` are under way, `copied` is waiting out the seven-day rollback
window, `complete` is done, `conflict` needs somebody, and `unsupported` is a
bucket without conflict-safe writes, where pressing again could only produce
the same refusal. Settings → Storage reports each of them and keeps a button
for exactly one — `conflict`, the resumable one.

**A rebind clears it, for the same reason a rebind clears `lastVerifiedAt` and
the note count, and with a worse failure if it does not.** A `complete` carried
onto a bucket that has never been migrated is a bucket the console never offers
the migration to: pre-v1 plumbing left where it is, dual reads carrying it, and
nothing on any screen saying so. Silent, unlike a stale green check.

The device flag stays, as belt and braces rather than as the mechanism. It
covers the seconds between pressing and the recorded state arriving, and it is
the whole of the answer for "Not now" — a preference, not an outcome, with
nothing on the binding to record.

**What a simplification costs.** Dropping the recorded state puts the nag back
for every device a person signs in on. Dropping the rebind clear silently
strands a new bucket on the old layout. Clamping the state to owners, the way
`noteCount` is clamped, would be a category error: that number is about private
notes, and this names no key and counts nothing of the customer's.
`apps/convex/__tests__/storage.test.ts` and the migration's end-to-end case in
`files.test.ts` fail; so do four checks in
`apps/mobile/__tests__/storageMigrationEntry.test.ts`.

## Absent meant two things, and the bucket is asked which

Recording the outcome above ended the nag for every context migrated *after*
it shipped, and for nobody else. `storageLayoutState` was only ever written by
a migration pass, so a context migrated before that kept `complete` in its own
bucket and an empty column on its binding — and "absent is the only state that
still offers" then read that empty column as *nobody has run it*. The notice
came back on every device, for ever, for exactly the people who had already
run it. **The owner who reported the original nag was still being nagged by
the fix for it**, which is the sharpest version of the failure: a decision that
was right about the mechanism and wrong about the population it applied to.

Absent was never one answer. It is "nobody has run this" and "nobody has
looked", and those are opposites for every bucket that predates the column.

So the question is recorded separately from the answer.
`storageBindings.storageLayoutCheckedAt` says the bucket was **asked**;
`storageLayoutState` stays what it **said**, absent when it has genuinely never
run. The notice offers only on asked-and-never-run. Settings → Storage takes
neither condition and keeps its button while the answer is unknown, because
pressing it is still correct and now records what it finds.

**Asking runs nothing.** `readStorageLayoutState` is one `get` against
`.context/migrations/storage-layout-v1.json` — no write, no delete, and none of
the conditional-write capability the migration itself demands, because a bucket
that can never *run* the migration can still say whether it already has. It
reaches a credential through `runFileOperation`, the enumerated barrier, rather
than through a second internal action that opens one; `observeStorageLayout` is
a public owner-only mutation that schedules it, on `reverifyStorage`'s model.
`verifyStorageBinding` does the same read in the credential open it already
makes, beside `countNotes`, so connect and re-verify answer it for free.

**A bucket that will not answer is not an answer.** `readStorageLayoutState`
returns `observed: false` and nothing is recorded — a timestamp written there
would claim knowledge nobody has and close the offer on a context that may
genuinely still need it. Conversely an observation of "no state file here"
*clears* a state we had: the bucket is authoritative and this row is a copy, and
a copy that outlives what it copied is the stale-green-check failure the rebind
clear exists to avoid.

**What a simplification costs.** Collapsing `observed` into the state records a
false absence, and the nag returns with extra steps. Dropping
`storageLayoutCheckedAt` and offering on absent state alone is the bug this
section exists for. Offering while the question is still in flight puts the
notice in front of somebody about to be told it is unnecessary. Failing to
clear the timestamp on rebind is worse than failing to clear the state: a new
bucket then reads as *asked, and never migrated* — an answer nobody obtained —
and is never offered the migration at all, silently, which is the outcome the
rebind clear was written to prevent. `apps/mcp/test/storageLayout.test.mjs`
(`runStorageLayoutReadChecks`), the observation cases in
`apps/convex/__tests__/storage.test.ts`, and two checks in
`apps/mobile/__tests__/storageMigrationEntry.test.ts` fail.

## A bucket born on the layout has nothing to migrate, and is not asked to

The two sections above each fixed the offer for the population they were about
and left a third one being nagged — and the third one is **every workspace
created since**, which is the worst population to get wrong: the first thing a
new owner sees in their console is an offer to update storage they made ninety
seconds ago.

`readStorageLayoutState` asked one question — is there a migration state file?
— and an absent state file was the whole of the answer. For a bucket that
predates `.context/` that is exactly right. For a bucket **we scaffolded
ourselves** it is nonsense dressed as an answer: `scaffoldContext` writes the
v1 layout and nothing else, so a context created last week has never held a
`.audit/` or a `.history/`, will never grow one, and has no state file for
precisely the reason a migrated bucket has one — there was never anything here
to move. Asked "has the migration run?", it truthfully said no. The question
was wrong.

So the probe asks what the offer actually rests on: **is there any pre-v1
plumbing in this bucket at all?** Nine `list`s capped at one object each, only
on the path where there is no state file to read, and none of them means the
hidden files are already on the current layout — `complete`, the same answer a
migrated bucket gives, because it is the same fact. Still read-only: no `put`,
no `delete`, no capability requirement, so a bucket that can never *run* the
migration can still answer.

**A bucket that will not answer is not an empty bucket.** A listing that
throws, or a store too old to have `list` at all, falls back to the answer this
replaced: nothing recorded, offer stands. Closing the offer wrongly is the
failure with no screen behind it — pre-v1 plumbing left where nothing mentions
it — and it is worth one more dismissible notice to avoid.

**Fixing the question does not fix the answers it already gave**, and those
answers are the new workspaces this is about: `observeStorageLayout` spends
itself on `storageLayoutCheckedAt` and never asks twice. So the generation is
recorded beside the answer — `storageLayoutCheckedVersion`, against
`STORAGE_LAYOUT_PROBE_VERSION` in `functions/lib/storageLayout.ts` — and a row
from an older probe is asked once more by the next console that opens. Not a
backfill: this repository is self-hostable, and a deployment nobody here can
reach must heal itself. Only the *absence* of a state is re-asked; a recorded
state is the bucket's own word and reads the same to every generation.

`storageLayoutAnswerIsCurrent` is one predicate read by both the console (as
`layoutChecked`) and the mutation, because a console that believed the question
was open while the backend refused to ask it would put the notice back,
silently, on exactly the buckets this closes it for.

**What a simplification costs.** Dropping the plumbing probe offers a one-time
update to every context on its first load, for ever, with nothing behind it.
Reading a failed listing as an empty bucket retires the offer on a bucket
nobody could see into — the silent half of non-negotiable #2's dual-read
promise. Dropping the generation stamp fixes only contexts created after the
deploy and leaves today's new workspaces nagging for ever, which is this
section happening a fourth time. `runStorageLayoutReadChecks` in
`apps/mcp/test/storageLayout.test.mjs` (thirteen checks, including one per
legacy prefix), the whole chain end to end in `apps/convex/__tests__/files.test.ts`
("a bucket born on the layout answers 'already current'"), the
probe-generation cases in `apps/convex/__tests__/storage.test.ts`, and three
checks in `apps/mobile/__tests__/storageMigrationEntry.test.ts` fail.

## The same absence, in the capability column, made after the rule was written

`capabilities` is the section above happening a second time, in a column whose
absence disables a feature rather than offering one — and it shipped *after*
that argument was recorded, which is the part worth keeping.

`storageBindings.capabilities` held `conditionalWrite` alone until 2026-09-12,
when `conditionalCreate` and `conditionalDelete` joined it as optional fields
and nothing went back for the rows that already existed. The gateway composes
`declared && probed` (`store/factory.js`) and **must** fail closed on an
unproven capability: a binding that claims conditional writes it does not have
loses somebody's edit silently, which is the one failure a notes product cannot
have. That rule is right and is not what was wrong. What was wrong is that
absent and `false` arrived at it as the same value, so every binding older than
the field reported no conditional delete and `moveSafetyRefusal` refused every
move in those workspaces. A paying customer found it, not a test.

That section also asserted the buckets underneath "have supported conditional
delete throughout", and **the backfill it argued for is what disproved it**:
once every row was probed rather than assumed, `conditionalDelete` came back
`false` on all of them. R2 accepts `If-Match` on DELETE and does not enforce
it, which is the shape the probe is built to catch and the reason it fails
closed. The refusal was reporting the truth; the feature it refused was the
thing that needed to change. See the section below.

Nothing re-asked, and that is the structural half. There was no storage job in
`crons.ts`, and `reverifyStorage` is a button an owner presses; asking somebody
to press it requires them to know a capability exists, to know their row is
missing it, and to connect that to a refusal whose text names their storage
provider. `serverSideCopy` was the same fault one step further along: probed
since #374 and never in the schema at all, so no re-verification could have
filled it in and every move paid a full read-and-write round trip.

**The read stays fail-closed; the write grows a backfill.** This is the
opposite resolution to the section above, and deliberately so. There the
question was recorded separately from the answer because *asking* is a `get`
that any bucket can survive. Here asking is a probe that writes, reads and
deletes under `.context/` — real work against somebody's endpoint — so the
gateway is not the place to do it, and an `undefined` it cannot resolve must
stay a refusal. `sweepUnprobedCapabilities` answers the question where a
credential is already open: hourly, bounded, `connected` rows only, carrying no
`structure` so it cannot scaffold, and audited with no actor because a probe
the customer did not ask for still belongs in the trail of a bucket they own.

**Adding a capability is adding a backfill, and the predicate is what makes
that automatic.** The sweep matches on *any* known capability field being
absent, never on `conditionalDelete` by name, so the next field reaches
existing rows without anybody remembering this section. Its scan is indexless
— absence is not a thing an index answers — which is affordable at one row per
workspace with storage and stops being affordable past roughly ten thousand of
them, where a Convex transaction can no longer read the table and the job
becomes an hourly error. That is the loud direction, and the remedy is an
indexed `capabilitiesProbedVersion` rather than a larger batch.

**A capability observed only as `false` is a capability untested.** The reason
this survived ten days is that the S3 stub ignored `If-Match` on DELETE and did
not serve `x-amz-copy-source`, so no test ever ran against a backend that
*has* these — every assertion agreed the answer was `false` and none of them
could tell why. A probe is a claim about a backend, so its test needs the
honest backend as much as the lying one.

**What a simplification costs.** Letting the gateway treat absent as "probably
fine" trades a refusal anybody can see for a lost write nobody can, which is
the trade this whole file exists to refuse. Dropping the sweep leaves the
repair to a button pressed by owners who cannot know they need it. Narrowing
its predicate to the fields that are missing today guarantees the next
capability is found by a customer again. Restoring a stub that ignores write
preconditions makes every capability test vacuous in the direction that works.
`apps/convex/__tests__/capabilityBackfill.test.ts`, the capability assertions in
`provisioning.test.ts` and `reverifyStorage.test.ts`, and the two legacy-binding
checks in `apps/mcp/test/storeFactory.test.mjs` fail.
