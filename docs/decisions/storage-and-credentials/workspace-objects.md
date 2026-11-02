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
(`agent/texEntryPoint.js`, dataset `tex_entry`) writes `store:get:object` and
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
  pictures and files included; how much of it is note text and editing
  history is not measurable with this deployment's read-only token (listing
  the bucket is refused). The backfill counts each workspace's bodies and
  history before it copies, and a workspace that would not fit is held back
  and named, never cut short.
- **2 MB per row.** Bodies are chunked, as Tex's are.
- **One object is single-threaded.** A busy workspace's reads are batched
  (`read(ids)`) rather than one request per note.

## Cost of reversing it

Note reads go back to five serial network calls, a turn's reads back through
the six-connection queue, and no read-many. Tests: the workspace object's
suite (`apps/mcp/test/workspaceStore*.test.mjs`), today's privacy suite run
against the object unchanged, and the parity checker.
