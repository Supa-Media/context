# Gateway protocol: what an AI client reads is kept, in the customer's bucket

**Decided by the owner, 2026-10-07**, reversing "the log is never written" for
reads ([Agent activity is announced from finished tool calls, never
streamed](../gateway-protocol.md)): "update it so that reads are stored, that
will be good for auditing and tracing security as well, also i really want it
in the replay". Until now a read lived only in the activity object's memory
window. A replay could show what was written, made and moved, and nobody could
ask afterwards which notes a tool had opened.

### Where it lives

In the workspace's own bucket, under `.context/reads/`, and nowhere else. A
read is a path plus who and when, and the control plane's rule for that is
already written down in `reportUsage`: what a person's tools looked at is
theirs, and their own trail in their own bucket is where a record of it
belongs. So the control plane holds none of it. It is exported and handed over
with everything else under `.context/` (non-negotiable #1), and it is not
something a self-hosted gateway needs us for.

- **One object per read**, `.context/reads/<YYYY-MM-DD>/<time>-<id>.json`, written
  once and never rewritten: `{at, tool, path, by, via, actor_user_id,
  actor_client_id, workspace_id, team_visible}`. A per-read object needs no
  conditional write, which B2 and Wasabi do not reliably offer, and two tools
  reading in the same millisecond never race. These objects are the record.
- **A roll-up per UTC day**, `.context/reads/<YYYY-MM-DD>.json`. It is a
  derivative: rebuilt from the listing whenever it is missing or behind, and
  an entry with no object behind it is dropped, so a lost, stale or tampered
  roll-up costs reads and never loses or invents one. It exists because a
  replay must not spend one subrequest per read against a Worker budget of 50
  on the free plan. Each ask spends at most the search budget
  (`searchBudgetFor`), fetches what the roll-up lacks newest first, writes the
  roll-up back, and says `truncated` when it ran out. A short answer is never
  presented as a complete one.

What is recorded is `read_note` and `fetch`, the two calls the live map already
draws as reads, and only after they succeed. A refusal records nothing, so "not
found" still costs the same as "not yours". The console's own client is never
recorded, because a person opening a note is not an AI reading it. Search
results are not recorded as reads.

### Who is told

Every read is filtered twice, both times against the reader. This is
`readFilterFor` (`apps/mcp/src/live/storedReads.js`), shared by the replay and
the trail:

1. **When it was read.** Below owner, a read is shown only when its note was
   `team` at that moment (`team_visible`). A note read while it was private
   never shows its read to the team, even after it is shared, because "Seyi's
   Claude opened the pricing draft on Tuesday" is history about a private
   note.
2. **Now.** The path is forwarded to where the note is today, through the
   ledger `read_activity` follows. It must then pass `canSee` against the live
   `privacy.md`, with groups treated as private as everywhere in this feed.

A read that fails either check is absent, never counted.

- **The replay** asks `GET /agent-activity?reads_since=<ms>&reads_until=<ms>`. Only
  the console's client gets reads there, and any other caller gets none. One
  ask covers at most eight days, a week plus the day it started on. The answer
  is `{reads: [{at, path, tool, by, via}], readsTruncated}`. `by`/`via` name a
  hand the way `activity.md` does, so a tool that read and then wrote is one
  face on the replay.
- **The trail** is `list_changes` with `reads: true`, a new argument on an
  existing tool (installed clients cache tool lists). It merges the last seven
  days of reads into the change records, newest first.

### What would break it

Each of these would break it, and each is sabotage-tested in
`apps/mcp/test/storedReads.test.mjs`:

- dropping the event-time flag;
- skipping the live `canSee`;
- answering a tool on the replay route;
- trusting the roll-up over the listing;
- never reporting `truncated`;
- recording the console.

Writing reads to the control plane or to Durable Object storage would also
break it. That is a different decision and is not this one.
