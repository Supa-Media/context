# A workspace object keeps its own word index

Decided 2026-11-03, for Dev's "keep working until reads and writes are less than 0.1 second". Search was the slowest
read: about 1.2 s for the answer in production, because each workspace's word search was a round trip to its
per-context D1 database over Cloudflare's HTTP API (`search/d1/client.js`), and a search reaches every workspace the
person can. A workspace whose notes live in its object (`home: object`) already holds every note's text there, so the
object keeps the same index beside it and a search is one call to the object.

## What it is

- **The same index, in the object.** `workspaceStore/searchIndex.js` keeps the search database's own tables (`notes`,
  `notes_private_fts`, `notes_team_fts`), filled by the same `projectNote` and `upsertStatements`
  (`search/d1/project.js`) and asked by the same `searchSql` (`search/d1/query.js`). The gateway's answer is the same
  `answerFromProjection` (`search/d1/serve.js`): the same ranking, the same live `canSee` over every row before it
  leaves, the same count taken after that filter. The object takes the queries as asks (`{table, match, prefix,
  limit}`) and builds the SQL itself; it never runs SQL it was sent.
- **A cache of the text, never older than it.** SQLite triggers on the rows table and on the notes' text tables write
  every changed row and note key into two change tables, whatever wrote them. Before a search answers, the object
  looks at each changed row again: it indexes the note again where its text, path or tier changed, and drops the old
  path of a moved or removed one (`ws_search_held` says which row each indexed path came from). A change of member
  rules marks every note row changed. Nothing is planned over the whole workspace on a search.
- **Chunks are removed by rowid.** The full-text tables' `path` column is `UNINDEXED`, so the search database's
  `DELETE ... WHERE path = ?` reads every chunk of every note. The object keeps each chunk's rowid
  (`ws_search_chunks`) and removes a note's chunks by them. Removing by path made each note's re-index cost grow with
  the size of the index: about 1.2 s per build call in production, and a full build of 18,000 notes took 90 s
  locally instead of 7.6 s.
- **The two tables are for corpus statistics, as in the search database**
  ([backfill-and-switch](./backfill-and-switch.md#corpus-statistics-are-per-tenant-which-is-why-it-is-a-database-each)):
  a note goes in the team table only where the member rules make it `team`, and a change of rules moves it. Which
  results a reader keeps is the gateway's `canSee`, after the object answers.
- **Asked first, and the search database stays.** `search/objectSearch.js` asks the object before anything else.
  Where the object is not the notes' home, the switch is off (`SEARCH_FROM_OBJECT=off`), the object fails, or it has
  more to catch up than one search may spend, the search database answers exactly as before.

## The one narrowing of "a search never builds an index"

[shard-routing](./shard-routing.md#a-search-reads-a-ready-index-and-never-builds-one) separates what a search reads
from what maintains the index, because maintenance was a bucket listing and hundreds of round trips in front of the
answer. Here, catching up is work inside the object over text it already holds, with no round trip, and it is
bounded: at most `QUERY_ROWS` (32) changed rows and `QUERY_BYTES` (32 KB) of note text before an answer, and never a
note longer than that. More than that and the search is not served here. `ws.search.build` catches up behind the
response, `BUILD_ROWS` (400) rows and `BUILD_BYTES` (64 KB) of text a call, one call after another (`BUILD_CALLS`).
Each call is short because the object answers nothing else while it runs. The budget is text, not time, because a
Durable Object's clock does not move while it computes.

The first production version (2026-11-03) planned the whole workspace on every call and removed chunks by path. A
build call held Seyi's workspace object for about 1.2 s, fetches queued behind it for 12 to 17 s, and one timed out
at 60 s. It was switched off in production (`SEARCH_FROM_OBJECT=off`, #2775) until the triggers, rowid removal and
text budget above replaced it.

## A query cuts a snippet for the rows it keeps, and the retry runs only when it is read

Decided 2026-11-18, from production's `mcp_entry` (search median 974 ms over 271 calls, of which `obj:ws.search` was
about 200 ms a call) and a local copy of the same queries.

- **Rows are read in FTS5's own rank order** (`rankedSearchSql`, `search/d1/query.js`). `searchSql` sorts by an
  expression, so SQLite built every matching row whole, snippet and chunk text included, before keeping 200: a
  query whose words matched 4,600 chunks cut 4,600 snippets. Ordered by `rank`, the snippet is cut for the rows
  read. The rows and their order are the same: rows of one score are put back in the table's own order
  (`rankedRows`), and a query whose cut falls between rows of one score is answered by `searchSql` itself, as is
  every query with a folder prefix (most of its matches are outside the folder, so rank order reads more, not less).
- **The any-word retry waits on the strict half** (`unlessRows`). It is the dearest of a search's three expressions
  and was run on every search, though it is read only when no strict row is one the caller may see. The object now
  leaves it unrun (`null`) when the strict half found rows; if none of those rows passes the gateway's `canSee`, the
  gateway asks for the retry alone (`answerFromProjection`, `SKIPPED`). The search database's path is unchanged: a
  round trip there costs more than the query.
- **Only a private-scope search leaves the retry unrun** (`lazyRetry`, `search/objectSearch.js`). A second call is
  one a caller can time. For a team caller it would be made exactly when a note they may not read holds every word
  they typed, which is the existence of that note told by a stopwatch. A private-scope caller may read every row, so
  there is nothing for the second call to tell. A team search runs the retry beside the strict half, as before.

Locally (4,000 notes, 16,000 chunks) a search's call went from 115 to 334 ms down to 53 to 165 ms.
`apps/mcp/test/searchSpeedEquality.test.mjs` answers a fixed set of queries both ways and fails on any difference in
the rows, the hits or their order.

## What it costs

- Each object holds a second copy of its notes' words, as the search database does; dropping the tables loses
  nothing, and the next search fills them again.
- A first search in a workspace that has never been indexed is answered by the search database while the object
  catches up behind it (locally about 7.6 s of object time for 18,000 notes, in calls of about 20 ms).
- A person's Tex notes are indexed from the Tex tables in their workspace's object. A group chat's home notes live in
  that chat's own object and are not in this index, so a word search the object answers does not find them; this is
  a known gap to close by asking those objects beside it.
- Meaning search (embedding the query and asking the vector index) is not changed here.

Reversing this means deleting `searchIndex.js` and `objectSearch.js`, or setting `SEARCH_FROM_OBJECT=off`;
`apps/mcp/test/workspaceSearchIndex.test.mjs` fails if the tiers, the text triggers, the text budget, the refusals or
the live `canSee` filter go.
