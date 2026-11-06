# Every request and every workspace object call is counted by who made it (2026-11-06)

On 2026-11-06, one workspace object took 18,624 requests in one minute, when it usually takes 300 to 500. Every
feature on that workspace failed together: a send was "overloaded", a read gave "malformed note id entries", the
Tex page lost its history, a job on a computer failed, and a note's mail vanished. Cloudflare's Durable Object
analytics name the object and the minute, but not which client sent the requests. The owner chose to count calls
first (2026-11-06), so the next spike names its source, and so we can see whether each later step (no Convex for
notes, mail pushed on a live channel, jobs that wait on pushes) lowers the load.

## What is written

There is one Analytics Engine dataset, `context_calls` (binding `CALL_COUNTS`; staging `context_calls_staging`). It
gets one point per call, from `apps/mcp/src/observability/callCounts.js`:

- **The gateway writes one point for every request it answers.** Its fields are `blob1` `in`, `blob2` the route as a
  fixed name (`agent/machine/run`, `mcp`, `collaboration`, `internal/workspace-store`, …), `blob3` the client's kind
  (`browser`, `node`, `claude-code`, `python`, `curl`, `convex`, `other`, `none`) and `blob4` the status class
  (`2xx` …). It also has `double1` 1 and `double2` the milliseconds, and the route as its index.
- **A workspace object writes one point for every call it answers.** Its fields are `blob1` `object`, `blob2` the op
  (`ws.rows.lookup`, `get`, … or `frame.machine`, `frame.tree`, `frame.access`, `frame.tex` for a socket frame) and
  `blob3` the caller. The caller is `gateway`, `convex` (through the door), `socket` (an upgrade) or `tex` (a
  person's Tex). Its index is the object's own id, the same id Cloudflare's `durableObjectsInvocationsAdaptiveGroups`
  names.

- **The door writes one point for every control-plane call it lets through** (added 2026-11-06, after the first
  production minutes showed about 4,000 note reads a minute arriving from Convex through the door). Its fields are
  `blob1` `door`, `blob2` the op and `blob3` the caller's own label, sent as `x-door-caller`: `file:<operation>` for a
  file operation (`lib/filesFns/fileOperationBarrier.ts`), `tree` and `facts` for the control plane's tree and fact
  reads, and otherwise the calling module's name. An unusable label is recorded as `unlabelled`, and a Convex caller
  that names none is recorded as `convex`. Its index is the workspace.

A point never holds a path, a slug, a note id, a token or a word. A route the list doesn't name is recorded as `page`
(a workspace's own path) or `other`, and an op that isn't a plain name is recorded as `other`. Writing a point never
throws and never waits, and without the binding nothing is written (tests, self-hosting).

## Reading it

Analytics Engine SQL (`POST /accounts/{id}/analytics_engine/sql`). This query gives one object's busiest minute,
split by op and caller:

```sql
SELECT toStartOfMinute(timestamp) AS minute, blob2 AS op, blob3 AS caller, SUM(_sample_interval) AS calls
FROM context_calls
WHERE blob1 = 'object' AND index1 = '<object id>' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY minute, op, caller ORDER BY minute, calls DESC
```

The same query with `blob1 = 'in'` grouped by `blob2, blob3` names the gateway route and the client kind behind a
spike.

## What a simplification would cost

Counting only at the gateway would miss Convex's calls through the door and every socket frame, which are two of the
suspects. Counting only in the object would miss which client route caused the calls. Putting a path or an id in a
blob would put customer data in a dataset that is kept for months. `apps/mcp/test/callCounts.test.mjs` fails if
either side stops counting, or if a path reaches a point.
