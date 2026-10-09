# Search — the workspace map's graph

### The map's graph is read per shard at request time, and stored nowhere

> **Superseded in part (decided by the owner, 2026-10-08):** once a context's
> tree table has read every note's links, the map draws from it instead of the
> shards, and the links are stored there. The serve-time privacy rules below
> are unchanged. See [Links live beside the tree](../app-and-console/tree-table.md#links-live-beside-the-tree-and-who-links-here-is-one-query).

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

**Shards are fetched in waves and parsed one at a time; only `path → links`
survives.** The PageRank note in `search/CONTRACT.md` is why: a global link
graph needs every shard in memory at maintenance time, which is the blowup v2
exists to remove. At request time the walk holds one parsed shard plus the
integer edge list, and a wave of `SHARD_READ_CONCURRENCY` (6) raw byte buffers,
as the search query walk does. Until 2026-10-08 the fetches were one at a time
too, and that was most of a slow map: a 15,000-note workspace is about 50
shards, so 54 round trips in a row from the control plane to the bucket. With a
simulated 100 ms per round trip, the graph read took 5.7 s; in waves, with the
privacy manifest, docmap and move jobs fetched together, it takes 1.4 s for
every note rather than 5,000. "Shards are fetched in waves"
(`__tests__/workspaceGraphCompact.test.ts`) fails if they go back to one at a
time.

**It draws every note** (decided by the owner, 2026-10-08: "I want us to show
all, but of course if an area is too dense we may not see details until we
zoom in"). The console asks with `compact: true` and gets every visible path
and every link, as chunks under Convex's 8,192-item array limit, with a title
being the file name and so not sent. Ceilings stay (`GRAPH_ALL_NODE_CAP`
60,000, `GRAPH_ALL_EDGE_CAP` 150,000) because one answer must stay a few
megabytes, but the index itself tops out near them. The canvas copes by
drawing what is on screen: notes are bucketed in a grid per layout and a frame
reads only the cells it sees, resting dots share one path and one fill, dots a
pixel or two across are squares, and level of detail is unchanged (names,
links and faces fade in by on-screen size), so a dense folder is a texture
until somebody zooms into it. The last answer per workspace is kept in the
tab's memory only (`graphCache.ts`, keyed by the session epoch, at most 30
minutes old, never on the device), so the map opens drawn and is replaced by a
fresh read a moment later. A role that shrank in that window shows the older
map until the fresh read lands; the cache is the person's own last answer in
their own tab, so it is accepted.

**The object answer is capped and honest, for old clients.** A console that
does not ask for `compact` gets what it always got: 5,000 nodes and 20,000 edges (`GRAPH_NODE_CAP`,
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
costs 67 reads, now in about a dozen waves. If links move into the fast-search
database with the file tree (proposed 2026-10-08 by the sidebar-tree work,
which owns it), the map reads from there instead, with the same serve-time
filter. Any such store must be a disposable derivative like the rest of
`.context/search/`, rebuildable and never the only copy of a link.

**The phone app draws the same map (2026-10-09).** React Native has no
`<canvas>`, so until now the native app showed only who is working and what is
happening. It now runs the web build's own engine in a `WebView`
(`map/live/webview/`), compiled into a committed bundle by
`scripts/build-map-bundle.mjs` the way the editor is, so it ships over the air
and the two can never drift into two maps. The web view reaches no network: it
uses the editor's document, whose Content-Security-Policy is
`default-src 'none'`, refuses every navigation, and gets people's photos from
the app as data URIs. Everything it sends back is checked
(`parseGuestMessage`); opening a note is rebuilt field by field. Graphs travel
only when they change, the rest of the data with every poll, and a web view
that reloads is sent everything again. Not a native canvas library
(Skia and the like): that is a second renderer to keep in step, and a native
dependency an over-the-air update cannot add. Guards:
`__tests__/liveMapWebview.test.ts`, `__tests__/mapBundle.test.ts`, and the
`editor-bundle` CI job, which rebuilds both bundles and diffs them.

**"Catching up" means a real gap (2026-10-09).** Every save of text leaves its
note waiting until the link table's next fill pass, which a map read
schedules, so a workspace anybody is writing in nearly always has a few. The
first link-table version said "catching up" whenever one was waiting, and the
notice was up on almost every open. It now shows only once at least 20 notes
and 5% of the workspace are waiting (`linksBehind` in `lib/fileOps/graph.ts`).
Only that one bit leaves the server, because the count includes notes the
caller may not see. While the notice is up the map reads again every 20
seconds instead of every 2 minutes, so it clears by itself.

**A tapped dot opens a card, not the note (2026-10-09).** Dev2: tapping a dot
left the map for the whole note, and Back did not come back to where they
were. Now a tap opens a card beside the dot (a sheet on a phone) with the
note's words, who is writing it and who is reading it, and Expand (Open note
on a phone) opens the note. Dev2 picked this over a peek in the side column.
What is being written shows as it is written: the card reads the note again
every 2.5 seconds while someone is writing it (every 15 otherwise) and marks
the blocks that changed since the last read, with the writer's name at the
caret. Reading is shown for the whole note, because the map records which
notes were read and not which parts; marking the parts being read needs the
gateway to record them first. Back works because the live map is a place in
the console's history (`mapPlace` in `files/history.ts`), so `‹` from a note
opened off the map returns to it. The map also keeps its camera, its open card
and its scope for the session (`peek/mapMemory.ts`), so it comes back as it
was left. Dropping the map from history fails `noteHistory.test.ts`, and a
card that stopped showing live writing fails `liveMapPeekCard.test.ts`.

### The replay picks a stretch of time, not a calendar day (2026-10-09)

A replay covers a stretch of time, not a calendar day. Past 24 hours and Past
week are rolling windows that end at the moment they are chosen, so a replay
at 9pm on a Tuesday shows the hours before it, not the hours since midnight.
Custom picks any run of days from the whole history: the picker draws one bar
per day since the first change, its handles snap to day boundaries, and the
end handle at today means now. A stretch is fixed when its replay starts, and
the idle window, arrow steps and ticks follow its length. A replay takes 2
minutes, 30 seconds or 10 seconds whatever the stretch is, so the speed is the
stretch over that length. Multipliers such as 60x were a conversion a person had
to make to know how long a replay would take. Dropping rolling windows back to
calendar days, or taking speeds as multipliers again, fails
`liveMapReplayBar.test.ts` and `liveMapRangeModel.test.ts`.
