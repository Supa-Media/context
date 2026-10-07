# App and console — the live map's history

The console map replays what happened (Today, This week) and shows notes moving
between a person's workspaces. Its graph is a search decision
([search/workspace-map](../search/workspace-map.md)); these are the two history
sources it reads, and what each reveals.

### A replay reads the activity feed, and a move line carries its pairs (2026-10-07)

Today / This week is replayed from `activity.md` through `files.listActivity`
— the file both writers already keep — rather than from a new event log. Two
changes made that possible, both additive:

**`since`.** `listActivity` took only a `limit`, defaulting to 50, which cuts a
busy week. It now takes `since` (epoch ms); with `since` and no `limit` it
returns every line in the window, up to the 400 the file keeps (about three
months of a busy shared context). Lines are still grouped — repeat saves by
one hand inside half an hour are one line — so a replay is as coarse as the
feed, which is the feed's own decision about what is worth showing.

**`moves: [from, to][]` on a `moved` or `archived` line.** Every reader forwards a line's
`paths` to where the note is *now*, so a move's own line reads `[to, to]` by
the time anyone sees it, a bulk move keeps only its destinations, and a grouped
line mixes several moves. The pairs are written once by `entryFor`, merged on
grouped lines, and **never forwarded**, because they are history. That makes
them the one part of a line `paths` cannot clear, so `visibleEntries` (shared
by the gateway and the console) re-asks `canSee` on both ends of every pair for
any reader below owner and drops a pair that fails — the line stays, since its
forwarded `paths` passed. Lines written before this read back with no pairs; a
cross-context move names one path in each bucket and carries none (see below).
Reversing the per-pair filter fails "a member does not receive a pair whose old
folder is private now" (`apps/mcp/test/activity/movePairs.test.mjs`) and
"a member gets a pair only while both of its ends are visible to them"
(`apps/convex/__tests__/files/activityReplay.test.ts`).

What AI clients read is kept apart, in the customer's bucket, since 2026-10-07
([stored reads](../gateway-protocol/stored-reads.md)); a replay asks each
workspace's gateway for its reads beside these lines.

### Moves between workspaces are read from the control plane, and an agent's move now leaves a row there (2026-10-07)

A move between two workspaces happens in two places. A console move already
has a `contextMoves` row with both ids, both paths, the mover and when it
finished. An AI client's `move_note` across contexts left rows only in the two
buckets' own `.context/audit/` folders — and walking every bucket a person
belongs to, listing and reading audit objects for a week, is not something a
map open can afford.

**The smaller sound change was to report it.** `acrossContexts.js` calls
`reportContextMove` after the move lands (deferred, swallowed, never able to
fail the move), `POST /gateway/moves` hands it to `recordAgentMove`, and that
writes the same `file.moveOut` / `file.moveIn` audit pair a console move
writes, with `{toWorkspaceId, toPath, via: "agent"}` on the source's row. It is
the first gateway report that carries paths, and that is argued, not
accidental: the record is an audit row, and audit rows carry paths for every
console move already ("paths are metadata, content is not"). It carries no
content. `recordAgentMove` records nothing unless the actor is an `editor` or
`owner` of both workspaces now, and the route answers `{ok: true}` whatever
happened, like its neighbours.

**What `workspaceMoves.list({from, to})` reveals.** Only moves between two
workspaces the caller is a member of now (never a pinned reach), in a window of
at most 31 days, and only those whose source path and destination path the
caller can see now — each judged by its own bucket's live `privacy.md` through
the credential barrier (`visiblePaths`), a folder by the file tree's own
folder rule. A move that fails either end is **dropped, not shown with a null
path**: the feed's rule is that a change somebody may not see is absent, never
greyed and never counted, and "Seyi moved a note you cannot see between your
two workspaces" is the countable gap that rule exists to prevent. For the same
reason no object count is returned — a console folder move's `movedObjects`
counts notes at the mover's clearance. Reversing the filter fails "an editor
sees the moves both of whose ends they can see, and no other"
(`apps/convex/__tests__/workspaceMoves.test.ts`).
