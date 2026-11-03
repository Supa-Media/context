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
- **A cache of the text, never older than it.** Before a search answers, the object indexes again every note whose
  text, path or tier changed since it was indexed, and drops notes that are gone, judged against its own live rows and
  member rules. A signature (the notes' and rows' counts and write times, and the rules' version) skips that check when
  nothing changed, and every write of a note's text clears it.
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
bounded: at most `QUERY_BUDGET` (8) notes, about 1.5 ms each, before an answer. More than that and the search is not
served here; `ws.search.build` catches up behind the response, `BUILD_BUDGET` (100) notes a call, one call after
another (`BUILD_CALLS`), each short because the object answers nothing else while it runs.

## What it costs

- Each object holds a second copy of its notes' words, as the search database does; dropping the tables loses
  nothing, and the next search fills them again.
- A first search in a workspace that has never been indexed is answered by the search database while the object
  catches up behind it (about 1.5 ms a note: some 7 s of object time for 5,000 notes, in 0.15 s calls).
- A person's Tex notes are indexed from the Tex tables in their workspace's object. A group chat's home notes live in
  that chat's own object and are not in this index, so a word search the object answers does not find them; this is
  a known gap to close by asking those objects beside it.
- Meaning search (embedding the query and asking the vector index) is not changed here.

Reversing this means deleting `searchIndex.js` and `objectSearch.js`, or setting `SEARCH_FROM_OBJECT=off`;
`apps/mcp/test/workspaceSearchIndex.test.mjs` fails if the tiers, the catch-up, the refusals or the live `canSee`
filter go.
