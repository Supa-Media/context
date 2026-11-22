# Search — one word scale across workspaces

### Across workspaces, word hits are scored on one scale (and a workspace can be weighed by its evidence)

Asked for by the owner, 2026-11-22: search "treats workspaces as equal" instead of ranking which one a query belongs
to, and filler words match everywhere. Each workspace object ranks its own notes by FTS5's BM25 over its own
statistics, so across several workspaces every workspace's first word hit ties ("Merge across workspaces" reads only
the rank), and a word rare in one small workspace counts as if it were rare everywhere. Distributed search has known
the fix since the 1990s: score every candidate with the same statistics.

**How.** With the `fuse` step's `sharedWords` 1 (`apps/mcp/src/search/config/searchConfig.json`), a search across
several workspaces adds one stats ask per table it reads to its one object call
(`workspaceStore/searchIndex.js`): the table's chunk count and, per query word (at most 24, each a quoted FTS5 string,
never an expression), how many chunks hold it. The same call's rows then carry how often each query word is in the
row's title and chunk, counted in the object, so the chunk never travels. `search/sharedWords.js` pools every
workspace's statistics and scores every word hit with BM25 (FTS5's own k1 1.2, b 0.75); a word hit's place in the
fusion is its place on that one list, and every word hit counts (the any-word retry's loose penalty is dropped, since
the scale already rewards holding more of the rare words). With `workspaceWeight` above 0, each workspace's hits are
also multiplied by its share of the top 50 shared scores, never below `workspaceWeight` (ReDDE's idea, Si and Callan
2003, kept soft: a floor, never a cut). If any workspace with word hits cannot give statistics (a database-path
workspace, an older object), the search ranks as it always has.

**Only what the caller may read is counted:** each workspace's statistics come from the tables of the caller's tier
there, the same tables FTS5's BM25 already scores against, and they reach no answer: the counts are stripped before
the hits leave `fuseEverywhere`. A search that will not use them (one workspace, or `sharedWords` 0) never asks.

**Measured on** `enterprise-rag-notes-split` (`./search-suite.md`), the one benchmark that searches several
workspaces, all 343 questions (2026-11-22): main's per-workspace ranks put the right note first 34.4% of the time
(nDCG@10 0.525), against 64.1% when the same notes sit in one workspace; `sharedWords` 1 puts it first 65.6% (top 5
84.5%, nDCG@10 0.802), so splitting notes across workspaces no longer costs anything. `workspaceWeight` 0.15 on top
of it lowered it to 60.3% (nDCG@10 0.757): weighing a workspace by its share of the evidence pushed down the one note a
small workspace held. So main runs `sharedWords` 1 and `workspaceWeight` 0; the weight stays a knob for a Lab draft.

**What a simplification would cost:** ranking by each workspace's own rank ties every workspace's first hit, so a
note that shares "the" and "for" with the question in a small workspace ties the one that holds the question's rare
words in a large one. Weighing workspaces with a hard cut instead of a floor drops a workspace whose one note is the
answer. **Tests:** `apps/mcp/test/searchSharedWords.test.mjs` (the scale, the floor, the fallback, fuse on and off,
no counts in the answer), `workspaceSearchIndex.test.mjs` (the stats ask and its refusals; a search not asking sends
none).
