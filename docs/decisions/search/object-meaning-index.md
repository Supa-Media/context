# A workspace object keeps its own meaning index

Decided 2026-11-03. Dev chose on the search decision card that every search waits for its meaning results ("Words in
object, always wait meaning"), with every read under 0.1 s. Search by meaning was two network calls: the query's
embedding (Workers AI, `@cf/baai/bge-m3`) and a query to the workspace's Vectorize index over Cloudflare's HTTP API.
A workspace whose notes live in its object (`home: object`) now also keeps its passages' fingerprints there. A
search is then the embedding and one call to the object, and the embedding is the only network step left.

## What it is

- **The same passages and model.** `workspaceStore/meaningIndex.js` cuts each note with `meaningPassages`
  (`search/meaning/project.js`) and embeds the passages with the binding embedder (`search/meaning/embed.js`), so its
  scores are the cosine Vectorize gives and the floors in `search/meaning/serve.js` keep their meaning.
- **Kept small, scanned whole.** Each passage is kept as one bit per dimension (its sign, 128 bytes, also held in
  memory) and one byte per dimension (1 KB, with its scale). A query scans every passage's bits by Hamming distance,
  keeps the closest `CANDIDATES` (400), and scores those by their bytes. Locally, 52,000 passages take about 20 ms per
  query once loaded. The first query after the object starts reads the bits in, which took about 0.3 s locally.
- **Caught up behind, never in front.** The same trigger-written change log as the word index (`changeLog.js`, as
  `ws_meaning`) says which rows changed. `ws.meaning.build` embeds at most `BUILD_PASSAGES` (512) per call behind a
  response, and the object answers other calls while it waits on the model. A row whose text is unchanged (a move, a
  change of member rules) has its path and tier rewritten without a model call. A row is taken off the log before
  the model is asked, put back if the model fails, and written only if it still holds the text that was embedded.
  A build gathers its rows first and asks the model for all their passages together, 32 to a call and
  `EMBED_PARALLEL` (4) calls at once: one note at a time, at about 130 ms a call, a 512-passage build took a minute
  and a large workspace's first build never finished (production, 2026-11-03).
- **Built on the object's alarm too** (`workspaceStore/indexBuild.js`). Once a build call says changes are still
  waiting, the object wakes a second later and builds both indexes again, until nothing waits; a failed model waits
  a minute. This lives only in memory: an evicted object forgets it, and the next search's build call starts it
  again.
- **Snippets from the object.** The snippets for the notes a search found only by meaning come from the object in
  one call (`ws.meaning.snippets`), read beside the text, instead of from the search database (about 170 ms) or a
  read of each note (two calls each). The gateway asks only for paths its `canSee` already let through.
- **Served once built.** Until its first build has finished, the object answers `served: false` and the gateway asks
  Vectorize exactly as before (`search/meaning/objectMeaning.js`). After that it answers from what it holds: a note
  saved a moment ago ranks by its last fingerprint until the next build, which is what Vectorize did too (the write
  path embedded behind the save). Who may see a match is still the gateway's live `canSee`, run on every match.
- **Vectorize stays.** Its write path and catch-up pass are unchanged. It answers a workspace whose notes are not in
  its object, one whose object has not finished building, the console's own searches, and every search while
  `MEANING_FROM_OBJECT=off`.

## What it costs

- Each object holds about 1.2 KB per passage: some 60 MB for a workspace of 50,000 passages, within an object's 10 GB.
  Dropping the tables loses nothing, and the next build fills them again.
- Every passage is embedded twice, once for Vectorize and once for the object, until Vectorize is retired.
- A workspace's first build embeds every note: about 9 s of local work for 52,000 passages, started by a search's
  build calls (`MEANING_BUILD_CALLS`) and carried on by the alarm.
- The object starts building when a search asks it to, or when a save, move or removal of a note is written behind
  its response (`meaningBuildBehind`, 2026-11-03: a save with no search after it had no fingerprint until one came).
  Live-editor saves (`meaning: false`) do not start it. A search only asks where meaning search is on for that
  workspace. One whose owner turned it off keeps whatever it built until its next layout change.
- A group chat's home notes live in that chat's own object and are not in this index, as with the word index.

Reversing this means setting `MEANING_FROM_OBJECT=off`, or deleting `meaningIndex.js` and `objectMeaning.js`.
`apps/mcp/test/workspaceMeaningIndex.test.mjs` fails if the tier filter, the no-re-embed path for moves, the retry
after a failed model, the batched model calls or the served-after-build rule goes;
`apps/mcp/test/workspaceIndexBuild.test.mjs` fails if the alarm stops building, never stops, or stops backing off.
