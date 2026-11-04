# A workspace's notes live in its workspace object

Decided by the owner, 2026-11-01: "go ahead and implement this with default
recommendations, except the timeline for this isn't a week it's a day". The
plan it approved moves each workspace's note bodies, its tree rows and its
access rules into one Durable Object per workspace. This replaces the rule
that a note's body lives in the workspace's bucket
([notes-by-id](./notes-by-id.md)) and the bring-your-own-bucket path
([own-storage-moves](./own-storage-moves.md)).

## Why

A note read today is five calls in a row, each over the network: the control
plane's id lookup, a probe, the id lookup again, the bucket read, and the
editing-history probe (traced 2026-11-01 in `tools/notes/read.js`). A turn
makes 250 to 350 bucket reads, and a Worker holds at most six connections at
once, so they queue: bucket reads measured p50 ~800 ms on a busy turn against
~170 ms alone (2026-10-31, `workersSubrequestsAdaptiveGroups`). R2 and S3 have
no read-many, so 500 notes cost 500 requests. Asked to get a read to "2
calls, check permission & read note", the answer is to keep the rows, the
rules and the text in one place that answers both in one call.

## What it is

- **One object per workspace**, class `WorkspaceStore` in the gateway, binding
  `WORKSPACE_STORE`, named `workspace:<workspaceId>` and placed with the
  location hint `enam` (`apps/mcp/src/workspaceStore/api.js`). Its storage is
  the same R2-shaped SQLite as Tex's objects (`texStore/objects.js`): keys,
  etags, conditional writes, chunked bodies.
- **In it**: `notes/<noteId>.md`, everything under `.context/collaboration/`
  except older saved versions (below), the workspace's tree rows, its grants and shares, and its access rules. A
  read is the permission check (`canSee`, unchanged) and the text, both inside
  the object, in one call; `read(ids)` answers up to 500 at once.
- **Older saved versions stay in the bucket.** A shared document's saved
  versions (`.context/collaboration/v1/revisions/`) are never deleted, and in
  @supa they were 13.1 GB of its 13.3 GB on 2026-11-01, against 191 MB for
  everything else (production dry runs, read-only). The object keeps each
  document's current and pending version, which every read of a started
  document needs (`finalizePending`); an older one is read only as the base of
  an offline edit's merge (`replace.js`), so it is read from the bucket, never
  copied in, and saving a document's state drops the object's copies of the
  ones it no longer names after ten minutes (a save writes its version before
  the state that names it). Every version is still written to the bucket, so
  an export or a purge lists the bucket's. Reversing it puts a busy
  workspace over the 10 GB object limit. Tests: `apps/mcp/test/workspaceRouting.test.mjs`.
- **Not in it**: pictures and other files (`files/**`) go to a files bucket of
  the workspace's own, pictures compressed on upload and PDFs and audio kept
  as they are. Accounts, usernames, sign-in, AI client grants, billing, audit
  and a "shared with me" index stay in the control plane, which still never
  holds a note's body.
- **A backup copy**: every save is also written behind to the workspace's
  managed bucket in the customer-data account. Nothing on a request ever reads
  it; it is what a lost object is rebuilt from, and the export's check.
- **The switch**: each workspace has a `home` of `bucket`, `dual` or
  `object` (`store/workspaceRouting.js`). Reads move one workspace at a time,
  after a backfill and a parity check with zero differences, and go back in
  one step. Old bucket keys and Convex node tables stay three days as the
  rollback, then go.
- **Bring your own bucket is retired.** Nobody new can connect one; each
  workspace on one gets a full export first and is listed to the owner before
  it is cut over.
- **Self-hosting** runs the same objects on `workerd` (`wrangler dev` or a
  workerd deployment), so cloning and deploying without us still works.

## Where the objects run: the gateway's account

Decided by the owner, 2026-11-01, choosing "Gateway's account (as built)" over running them in the customer-data account.

A Durable Object answers only to Workers in its own Cloudflare account ("by
other workers on the same Cloudflare account that declare a binding to it",
Workers RPC docs). The customer-data account holds no Worker of ours by rule
([managed-storage](./managed-storage.md)), so it cannot hold these objects.
They run in the gateway's account, where Tex's objects (`TexStore`) and the
live-typing rooms (`PresenceRoom`) already run: the account's Durable Object
namespaces list both under the gateway's script, 2026-11-01. The
customer-data account keeps the buckets (the backup copies and the files) and
the search databases, and still nothing of ours. Isolation between workspaces
is the object boundary: one object per workspace, a name derived from the
immutable id, and a store that is never handed another workspace's object.

**Every object of ours is placed in eastern North America** (decided by the
owner, 2026-11-01): workspace objects, Tex's objects, the live-typing rooms,
the texting Worker's inboxes and the small infra objects. An object is placed
once, near whatever first asks for it, and never moves. Tex's objects were
asked for without a hint, and the first calls to the six busiest (about 80% of
their traffic, 2026-10-25 to 11-01) came from gateway requests that ran in
London on 2026-10-31, so they live in London and Amsterdam while 98% of
gateway requests run in Virginia. Each Worker makes stubs only through its
`objectPlace` helper; `scripts/check-durable-object-location.mjs` (fast
guards) fails on any other. The hint changes nothing for an object that
already exists: those six are copied to new names to move.

**How Tex's objects moved** (2026-11-02, `apps/mcp/src/texStore/move.js`).
Every Tex store, not only the six, now lives under `enam:<owner>`
(`enam:person:<workspaceId>`, `enam:chat:<chatId>`), so the name says where
it was placed and no list of moved owners has to be kept anywhere (a list
would be customer identifiers in config). The first call to a placed store
copies the old store in before it answers: the old store stops keeping
writes in one synchronous step (a write already under way is stopped by the
objects' guard), every object comes across checked against its etag, the
routine alarms come with it, and the placed store compares its own list with
the old one, key by key, before it is marked arrived. Any difference throws
the copy away and the call fails; the next call starts again. A store is
never answered from half-copied. The old store passes every later call on
(a gateway still on the old code during a deploy loses nothing), runs no
routine, and clears its copy after three days by its own alarm, or at once
when the store is wiped. Every move is one `tex_entry` point (step
`tex_store_move`) carrying the old object's id, which is how the six are
tied to their owners. *Simplification cost:* moving only the six, by a list,
puts workspace ids in config and leaves two naming rules forever; dropping
the parity check lets a cut-short copy answer as if whole. Tests:
`apps/mcp/test/texStoreMove.test.mjs`.

**Rooms and inboxes moved the same way** (2026-11-02). Cloudflare analytics
for 2026-10-25 to 11-02: all 576 workspace objects were already in eastern
North America; 2,177 of 4,209 live-typing rooms and 21 of 60 texting inboxes
were not. Rooms now live under `enam:<key>` (`apps/mcp/src/objectPlace.js`
`roomByName`) with no copy, because a room holds nothing lasting. Inboxes
live under `enam:<name>` (`apps/agent/src/objectPlace.ts` `inboxByName`) and
copy in from the old name (`apps/agent/src/inboxMove.ts`), but only while the
old inbox is idle (no call, alarm or handed-on work running), since a turn
waits on the gateway for seconds. Until then, and after any failed copy, the
old inbox keeps answering, so a move never stops anyone's texts. The copy is
checked by a digest the old inbox computes over every key and value, and a
value the copy cannot carry exactly refuses the move. Tests:
`apps/agent/src/inboxMove.test.ts`.

## Measured (production, 2026-10-31 18:00 to 2026-11-01 18:00 UTC)

Tex's objects use the same storage code a workspace object will, so they are
the measurement. Cloudflare GraphQL analytics,
`durableObjectsInvocationsAdaptiveGroups` and `durableObjectsPeriodicGroups`,
for the gateway's `TexStore` namespace:

| | |
|---|---|
| Requests from the gateway | 5,033 a day, no errors |
| Time inside the object, per request | p25 0.47 ms, p50 0.70 ms, p75 2.6 ms, p90 147 ms |
| Response size | p50 1.75 KB, p99 124 KB |
| Billed active time | 1,051 s a day (131 GB-s at 128 MB) |
| CPU | 3.2 s a day |
| Rows read / written | 12,445 / 1,105 a day |

The p90 tail is not explained yet; the per-call timing below settles whether
it reaches a reply.

The gateway's side (the hop from the Worker to the object, which inside-object
time does not include) is now timed on every texted turn: the Tex entry point
(`agent/texTiming.js`, dataset `tex_entry`) writes `store:get:object` and
`store:get:bucket` per call, from the same Worker in the same turn. Query:

```sql
SELECT blob3 AS call, count() AS calls, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms,
       quantileExactWeighted(0.9)(double1, _sample_interval) AS p90_ms
FROM tex_entry WHERE blob3 LIKE 'store:%' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY call ORDER BY calls DESC FORMAT JSON
```

First production numbers, 18:40 to 19:17 UTC on 2026-11-01 (a quiet Sunday
evening: two group turns and two routine runs; Analytics Engine sampled the
points, and the quantiles are weighted by it):

| Call from the gateway | Points | p50 | p90 | max |
|---|---|---|---|---|
| `store:get:object` (a Tex object) | 5 | 19 ms | 279 ms | 425 ms |
| `store:get:bucket` (R2 over S3) | 136 | 321 ms | 780 ms | 946 ms |
| `store:put:bucket` | 6 | 617 ms | 2,249 ms | 2,249 ms |
| `store:list:bucket` | 12 | 48 ms | 311 ms | 13.8 s |

In the same turns, a read from an object came back in a sixteenth of the time
of a bucket read at the median. The bucket figure includes the queue behind
the six-connection limit, which is the point: an object read is one call that
the limit does not multiply. Five object reads is a small sample; re-run the
query above as texts come in, and before switching reads over.

## Cost

Cloudflare's published prices (Workers Paid): Durable Objects $0.15 per
million requests after 1 million, $12.50 per million GB-s after 400,000 GB-s
(billed at 128 MB per active object; an idle object is not billed), SQLite
rows $0.001 per million read after 25 billion and $1.00 per million written
after 50 million, stored data $0.20 per GB-month after 5 GB, and 10 GB at most
per object, 2 MB per row. R2 Standard is $0.015 per GB-month, $4.50 per million
writes and $0.36 per million reads.

The busiest workspace we can see, Supa Media's own, made 48,252 bucket calls
in the same day (42,586 reads, 3,280 heads, 1,673 writes, 714 lists). Moved
call for call, with the average active time Tex's objects showed (0.21 s a
request, which overstates it, since most of that is time held open after a
request):

| | per month |
|---|---|
| Requests | 1.45 million, about $0.07 past the included million |
| Duration | ~38,000 GB-s, inside the 400,000 included |
| Rows | well inside the included reads and writes |
| Storage | $0.20 per GB of notes and history, against $0.015 in R2 (13x), plus the backup copy in R2 |

So the running cost is storage, and it is small: a workspace with 1 GB of note
text and history costs about $0.20 a month in its object.

## Limits that bind

- **10 GB per object.** Supa Media's bucket holds 13.3 GB and 78,096 objects,
  pictures and files included. What its object holds was measured by the
  production copy on 2026-11-02: 11.8 MB of note text for 4,951 notes and
  103.5 MB of editing history (32,347 keys), 115 MB in all; the other
  13.7 GB is older saved versions, which stay in the bucket. The backfill
  counts each workspace's bodies and history before it copies, and a
  workspace that would not fit is held back and named, never cut short.
- **2 MB per row.** Bodies are chunked, as Tex's are.
- **One object is single-threaded.** A busy workspace's reads are batched
  (`read(ids)`) rather than one request per note.

## Cost of reversing it

Note reads go back to five serial network calls, a turn's reads back through
the six-connection queue, and no read-many. Tests: the workspace object's
suite (`apps/mcp/test/workspaceStore*.test.mjs`), today's privacy suite run
against the object unchanged, and the parity checker.

## A store over an object-home workspace never writes the bucket alone (2026-11-02)

The store factory routes note texts to the object only for a binding that names its workspace. The console's
credential named none, so from the moment a workspace's home became `object` every note the app made, duplicated
or saved went to the bucket alone. The gateway reads the object, never the bucket, so live editing could not open
the note and the app showed it read-only.

**Decision.** `consoleWorkspaceRouting` puts the workspace, its home and its backfill time on the credential, and the
factory refuses (`StorageUnavailable`) a binding whose home is `dual` or `object` when it names no workspace or its
object cannot be reached: refused, never built over the bucket. Notes already written to the bucket alone are put back
by the repair (`workspace-objects-repair` workflow): a note text the object lacks is restored when a live tree row
still reads its key, and left alone otherwise. The same split means editing history the object lacks may be the only
copy of a live note's history, not an erase the bucket missed, so the repair deletes such a key from the bucket only
when its copy was written before the erase leak was fixed (2026-11-02 09:37 UTC) and its note, named by the head's
note id or path or by the bucket state's path, has no live row; anything else is left alone
(`workspaceObjectsRepair.test.ts`, "history only the bucket ever held is never deleted as an erase").

**What a simplification would cost.** Letting the factory fall back to the bucket store again brings the silent
split back. `apps/convex/__tests__/consoleObjectWrites.test.ts` creates and saves a note through the console in an
object-home workspace and finds it in the object; `apps/mcp/test/storeFactory.test.mjs` holds the refusal.

## A save's audit entry and activity line are written behind the answer (2026-11-03)

Production timings after the phase timers went live (2026-11-03, 16 saves) put the audit put at 0.36 s p50 and the
activity line, a read and a conditional write of `activity.md`, after it, both awaited in front of every save's answer.
Neither is the change: the note has landed when they run, and the activity line was already unable to fail it.

**Decision.** `recordChange` hands both to `store.defer` (`ctx.waitUntil`), audit first, so they finish inside the
same invocation after the answer has gone. One store's bookkeeping runs one change after another, so two changes in
one request never race for `activity.md`. A deferred audit put that fails is not the change failing. Where there is
no `defer`, both are awaited as before. A routing suggestion (`route_suggestion`) keeps its audit in front: that entry
is the only thing the call writes, and `suggest_destination` refuses to suggest what it could not record.

**What a simplification would cost.** Awaiting them again puts two to three storage round trips back on every save.
Dropping the per-store chain lets two changes in one request lose an activity line. `apps/mcp/test/bookkeepingBehind.test.mjs`
holds all three, and its ordering check fails when the chain is removed.

## A save's editing history runs inside the workspace object, in one call (2026-11-03)

The collaboration engine makes about seven dependent storage round trips per whole-note save (head, Markdown and
state, current revision, new revision, state compare-and-swap, Markdown, state). From the gateway each one is a trip
to the workspace object.

**Decision.** For an object-home, backfilled workspace, `write_note`'s save goes to the object as one
`ws.collab.replace` call (`workspaceStore/collabReplace.js`). The object runs the same engine against its own
SQLite, so conditional writes, `CONFLICT` and the retry on a lost compare-and-swap are unchanged. The gateway's id
layer names the key, note id and row version it resolved, and the object refuses (`served: false`) when its own live
row says otherwise. It also refuses when a read needs a saved version the object no longer keeps, or a listing; the
bucket keeps those. Every write the object made comes back to the gateway, which copies it to the bucket behind the
response and prunes as an ordinary put does. The new Markdown version is reported by the id layer as `keyedPut`
reports one. If the call fails on the way, the engine runs from the gateway. That is safe because the engine only
commits on the version it read, so a save the object already committed comes back as a conflict, never as a second
write.

**What a simplification would cost.** Running the engine from the gateway again puts about seven object round trips
on every save. Dropping the row check lets a save land on a note the tree has since moved or replaced. Dropping the
fallback for versions the object no longer keeps fails saves on notes edited from an old base.
`apps/mcp/test/collabReplaceInObject.test.mjs` holds the one call, the conflict, the row check, the fallback, the id
layer's report and the unreachable object, and its row and fallback checks fail when those guards are removed.

## A member's save records its new version in that same call (2026-11-03)

A member's save on an object-home workspace sends `record: {at}` with `ws.collab.replace`. The object then records
the new Markdown version on the note's row, the same way `ws.write.wrote` does. The change goes into the control
plane's mirror queue in the same transaction. The answer says `recorded: true`, and the gateway sends no second call.
This happens only where the version report would have gone to the object anyway: `objectLookup.js` marks its member
`wrote` hook `inObject`. A guest's or a chat's report still goes to the control plane. A save that conflicts records
nothing. An object that cannot record the version answers `recorded: false`, and the id layer reports it as before.

**What a simplification would cost.** Sending the report as its own call again puts one more object round trip on
every save. Marking every audience lets a guest's save change the row without the control plane's check.
`collabReplaceInObject.test.mjs` fails if the id layer reports twice or if the mirror entry is dropped.
`objectLookup.test.mjs` fails if a guest's hook is marked.
