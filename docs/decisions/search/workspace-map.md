# Search — the workspace map's graph

### The map's graph is read per shard at request time, and stored nowhere

The console's map draws every note a person can see as a dot and every link
between two of them as a line. Both come from `files.workspaceGraph`
(`apps/convex/functions/lib/fileOps/graph.ts`), and the shape of that function
is the decision:

**It reads the search index that already exists, and nothing else.** The
docmap names every note and the shard that holds it; each shard stores, per
note, the `.md` targets the indexer already resolved out of its text
(`extractLinks` in `apps/mcp/src/search/indexer.js`). So a map costs the
privacy manifest, the index manifest, the docmap and one read per shard — no
bucket listing and no note body, ever, on the customer's request quota. A
graph built from a listing plus body reads would be a second index paid for on
every open of the map, which is what `notePaths` already declined to be ("L1"
in [app & console](../app-and-console.md)).

**It is filtered at serve time, from the visible set alone.** A node is a path
that passes the caller's own `canSee` and is not plumbing — `notePathIndex`'s
filter. An edge exists only when both ends are nodes. A bare `[[name]]` the
indexer resolved to a path that is not a node falls back to a unique file-name
match **among the nodes**, never among the docmap, so the answer is identical
whether or not a hidden note exists at the resolved path; an ambiguous name is
not drawn. A shard that holds no visible note is not read at all, so a broken
shard full of private notes cannot turn into a `behind` flag for a team member.
Reverse any of these and "the team answer is identical whether or not the
hidden note exists" or "a team caller sees neither the private note nor any
edge into or out of it" (`__tests__/workspaceGraph.test.ts`) fails.

**Shards are read one at a time and only `path → links` survives.** The
PageRank note in `search/CONTRACT.md` is why: a global link graph needs every
shard in memory at maintenance time, which is the blowup v2 exists to remove.
At request time the walk holds one parsed shard plus the integer edge list.

**It is capped and honest.** 5,000 nodes and 20,000 edges (`GRAPH_NODE_CAP`,
`GRAPH_EDGE_CAP`), with `truncated` set when either cut, `noteCount` (every
visible note, drawn or not) and `linksCut`, so the map says "Showing 5,000 of
8,214 notes" rather than "the first part". The node cap is **shared, not cut
A to Z** (`shareOfNotes`, 2026-10-07): the first version kept the first 5,000
paths, so a personal workspace with a big `0-inbox/` drew nothing after it.
Now each folder at a level gets an equal share, a folder that needs less gives
the rest back, and each splits its share among its subfolders the same way;
loose notes in a full folder keep the last by name, the newest for dated
names. `noteCount` counts only notes the caller can see. `behind` is the
index's own freshness (the flag search reports) or a visible shard that could
not be read, and `indexMissing` is a bucket nothing has indexed — an empty map
there would tell somebody their notes are gone when nothing looked. The action
schedules no maintenance, for `notePaths`' reason: the next ordinary search,
or the hourly pass, catches the index up.

**Why not a derived graph file yet.** A `.context/search/graph.json` written at
maintenance time would make the map one read instead of one per shard. It is
not built because it needs exactly what v2 gave up — every shard's links in
memory, or a second incremental structure kept in step with every shard write
— and because it would still have to be filtered per caller at serve time, so
it saves reads and none of the privacy work. At the shard ceiling (64) a map
costs 67 reads, which a Convex action affords. Revisit when a measured map open
is slow, with a design that keeps the one-shard memory bound; it would be a
disposable derivative like the rest of `.context/search/`, rebuildable and
never the only copy of a link.
