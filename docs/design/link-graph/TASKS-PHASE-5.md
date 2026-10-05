# Link graph: Phase 5 tasks

Part of the task breakdown for [PLAN.md](./PLAN.md); global constraints and Phases 0 to 2 are in [TASKS.md](./TASKS.md). Split out so each file stays under the repository's review threshold.

## Phase 5 tasks

Drafted from PLAN.md Phase 5, BASELINE.md and the architecture. The open points (OPEN-47 to OPEN-75) are settled as controller rulings the owner can reverse at review. Nothing changes default search: every arm stays behind a switch, and flipping a default is the owner's decision (OPEN-73).

### Phase 5 global constraints

All of TASKS.md "Global constraints" apply unchanged. In addition:

- **Nothing changes default search unless the bench shows a win** (P9, PLAN Phase 5 Tests). Tokenizer v2, chunking and graph boosts ship off. With every switch off, B0 quality and subrequest rows must reproduce BASELINE.md exactly (see "Bench check per task").
- **Index formats are versioned with dual reads** (CLAUDE.md non-negotiable 3; the on-bucket layout is a versioned stable format, search indexes are disposable derivatives). Readers accept the old and the new format; a writer emits the new one only behind the switch; a newer format a reader does not understand is refused like any invalid shape (CONTRACT.md v2 rule), never parsed optimistically.
- **Indexer, query parser and the app's local search switch tokenizer together** (PLAN Phase 5 API). There is one tokenizer function per version, used by every side; nothing re-tokenizes on its own (`search/text.js` header).
- **No new runtime dependency** (P10, `scripts/check-gateway-imports.mjs`). `Intl.Segmenter` and `crypto.subtle` are Web APIs.
- **File growth.** No handwritten file over 1,000 lines, and CI's architecture check fails a file over 700 lines that grows. Today over 700: `search/shards/sync.js` (885), `search/visible.js` (812), `search/CONTRACT.md` (721). Edits to those three must be line-neutral (ruling OPEN-72).
- **Privacy.** Visibility is decided on the containing note (`doc.notePath`), never on a sub-document key (CONTRACT.md "canSee runs on the containing note"). Graph signals follow the Phase 3 and 4 global constraints (indistinguishable absence, possibly incomplete is said).
- **Bench check per task.** Before Task 26 changes anything, the implementer runs `pnpm --filter @context/mcp bench:search -- --sizes 100,1000` on the Phase 4 head and confirms Recall@10, nDCG@10, MRR and subrequests per query for B0 and B5 match BASELINE.md (latency columns vary by machine and are not compared). If they do not match, stop and report; Phases 1 to 4 must not have moved B0. Every later task that touches a search path reruns the same command with switches off and reports the four columns as unchanged. Switched-on numbers are measured in Task 38 only, so no task tunes against the evaluation set (DELIVERY 17.5).

### Phase 5 decision table

| Choice | Answer | Source |
|---|---|---|
| Per-note cap | 64,000 characters, `partial` coverage flag past it | P8, PLAN Phase 5 |
| Chunking | About 2,000 characters; split at headings, then paragraphs, then sentences; hard maximum 3,000 | P8 |
| Chunk sizes benchmarked | 1,000, 2,000, 4,000 | P8 |
| Maximum at targets other than 2,000 | OPEN-54 (Task 27) | P8 gives 3,000 only for 2,000 |
| Chunk mechanism | Sub-documents `path#c<n>` with `notePath`, reusing `commsIndex.js` | P8, PLAN Phase 5 |
| Chunk doc fields and title | OPEN-53 (Task 36) | `anchor` drives message snippets in `visible.js:563` |
| Placement and sizing of chunked notes | OPEN-60 (Task 36) | CONTRACT.md v2 sizing formula |
| Results per note | Deduplicated to notes; counts are notes, not chunks | README 12.5 |
| Chunk scoring | OPEN-61 (Task 33) | README 12.5 says dedupe, not how |
| Surfacing `partial` | OPEN-55 (Task 36) | README 12.5 "limits ... must remain explicit" |
| Tokenizer v2 steps | NFKC, lowercase, `Intl.Segmenter` words, accent folding, identifier splitting (whole and split), CJK two-character pieces as recall fallback, Porter2 for Latin-script words, other scripts unstemmed | P9 |
| Apostrophe U+2019 to `'` | Tokenizer v2, not the stemmer | Controller ruling (caller) |
| CJK script set and fallback mechanics | OPEN-48 (Task 30) | P9 says "CJK" and "recall fallback" only |
| Accent folding scope | OPEN-49 (Task 30) | P9 says "accent folding" only |
| Identifier rules | OPEN-50 (Task 30) | P9 "camelCase, snake_case, dotted, whole and split" |
| Minimum token length | OPEN-51 (Task 30) | today `>= 2` (`text.js:14`) |
| Runtimes without `Intl.Segmenter` | OPEN-52 (Tasks 30, 35) | verified only in pinned `workerd` (BASELINE) |
| Porter2 vocabulary test | Snowball pairs, full vocabulary when available locally, else a checked-in sample; download OPEN-47 (Task 26) | PLAN Phase 5 Tests; porter2.test.mjs TODO |
| Per-language stemming | OPEN-71 (Task 39) | P9 "revisited after Phase 0 measures note languages" |
| Index format layout and dual reads | OPEN-56 (Task 28) | non-negotiable 3, PLAN "behind an index format version" |
| Switch shape | OPEN-57 (Tasks 28, 31) | PLAN "behind a switch"; none exists |
| Revisioned shards | New shard revision per write, exact key/digest in the conditionally published manifest, old revisions retained for in-flight readers | README 12.6, PLAN Phase 5 Data model |
| Revision key and digest | OPEN-58 (Task 31) | README 12.6 "exact key/digest" |
| Revisioning reaches today's v2 index | OPEN-74 (Task 31) | README 12.6 is a gate for the replacement design |
| Revision retention and GC | OPEN-59 (Task 32) | README 12.6 "retaining old revisions" |
| Mobile local search parity | OPEN-62 (Task 34) | PLAN "the app's local search switch tokenizer together" |
| Staging `Intl.Segmenter` check | OPEN-63 (Task 35) | BASELINE "first staging deploy carries a check" |
| Graph fusion for search | Rank fusion of lexical and graph candidate lists with bounded boosts; lexical hit never buried; graph never required for a lexical hit | PLAN Phase 5 API, README 12.3; design OPEN-67 (Task 29) |
| Graph switch and wiring | OPEN-68 (Task 29) | PLAN Files lists `search/visible.js` |
| Ablation matrix | B0 to B5, B2 versus B1 is the graph-value comparison | PLAN Phase 5 Tests, DELIVERY 17.1, 17.3 |
| Matrix arms and order | OPEN-75 (Task 37) | P8 chunk sweep plus P9 tokenizer arm |
| Held-out set | OPEN-64 (Task 37) | PLAN "win on the held-out set"; none exists (BASELINE: one corpus, seed 1) |
| Judged queries where links matter | OPEN-65 (Task 37) | DELIVERY 17.3 "questions requiring more than one note"; BASELINE has no such class |
| What "wins" means | OPEN-66 (Task 38) | P9, DELIVERY 17.3 per-class rule |
| Staging latency for the P3 gate | OPEN-69 (Task 38) | BASELINE "set once staging round trips ... are measured" |
| Where results and decisions are recorded | OPEN-70 (Tasks 38, 39) | PLAN "bench reports", "Across every phase" |
| Who flips a default | OPEN-73 (Task 39) | P9, P1 |

---

## Task 26: land Porter2 on the Phase 5 branch

**Files:** `apps/mcp/src/search/porter2.js` (163 lines, from `link-graph/porter2`), `apps/mcp/test/porter2.test.mjs` (373 lines), `apps/mcp/package.json` (test script).

- Cherry-pick 25969de8 and 88d6bf38 from `link-graph/porter2` (based on Phase 0 commit be040641) onto the Phase 5 branch; resolve the `package.json` test-script line by appending `test/porter2.test.mjs`. No change to the module's contract: one lowercase word in, stem out; any character outside a-z and `'` returns the input unchanged; never throws. Not wired into anything in this task.
- First run the "Bench check per task" baseline confirmation (global constraints) and record the result in the task report.
- **Ruling (controller, OPEN-47):** the full Snowball vocabulary. PLAN accepts "a checked-in sample of it" when the full list is not available locally; the existing test carries the page's sample table plus derived per-step cases, and its TODO says the full `voc.txt`/`output.txt` needs owner approval to download. Recommend: ask the owner once; if approved, check in a deterministic sample of the published pairs (every 20th line, as a plain-data fixture under `apps/mcp/test/fixtures/`) with the source URL and fetch date in its header, and assert every pair; if not approved, ship with the existing page-derived sample and say so in the PR. Never a test that skips when a file is absent. Cost if wrong: an algorithm divergence on a rare suffix shows up only on real notes as a missed morphology match (recall, not correctness of storage).

**Tests.** The cherry-picked suite passes unchanged and is counted in the node:test totals. If the sample fixture is added: one test over it. Sabotage: change one Step 2 rule and confirm the sample test fails (record it).

**Bench.** Not wired; the baseline confirmation above is this task's bench output.

**Parallel:** group A (Phase 5 start), with Tasks 27, 28, 29.

## Task 27: `chunkNote`

**Files:** `apps/mcp/src/search/chunk.js` (new), tests `apps/mcp/test/chunkNote.test.mjs` (new).

**Data model.** A chunk: `{ index: number, start: number, end: number, text: string, headingPath: string[] }`; offsets are JavaScript string offsets into the input; `headingPath` is the enclosing heading texts from outermost to innermost at `start`.

**API.** `chunkNote(path, text, { target, max, cap })` returns `{ chunks, partial: boolean }`. Pure and synchronous.

- Input is first cut at `cap` (64,000 by default, P8); `partial` is true when the text was longer.
- Split at headings, then paragraphs (blank lines), then sentences, then (only when one sentence exceeds `max`) at the last whitespace before `max` (P8). A chunk aims at `target` and never exceeds `max`. Chunks concatenated in order reproduce the capped input exactly (no character lost or duplicated).
- Frontmatter stays in chunk 0. A fenced code block is not split unless it alone exceeds `max`.
- Sentences: `Intl.Segmenter` with `granularity: "sentence"` when present, else a split after `.`, `!`, `?`, `。`, `！`, `？` followed by whitespace or end. Only word granularity was verified in `workerd` (BASELINE), so the fallback is required, and the test covers both paths.
- **Ruling (controller, OPEN-54):** `max` at other targets. Recommend `max = 1.5 * target` (1,500, 3,000, 6,000), so the 4,000 arm is not capped below its own target. Cost if wrong: the 4,000 arm measures a different shape than intended; one constant.

**Tests (write first).** Concatenation equals the capped input (property over every bench fixture note and a few hand cases); no chunk over `max`; a 10,000-character single paragraph splits at sentences; a single 5,000-character sentence splits at whitespace under `max`; headings start new chunks and `headingPath` is right for nested headings; a code fence under `max` is never split; frontmatter only in chunk 0; text exactly `cap` long is not `partial`, one character longer is; CRLF input keeps offsets correct; the sentence fallback (Segmenter deleted) gives the same boundaries on an ASCII sample. Sabotage: drop the `max` check and the long-sentence test fails; let the cap drop a character and the concatenation test fails.

**Bench.** Pure; not reachable from search. No bench run needed beyond confirming nothing imports it yet.

**Parallel:** group A, with Tasks 26, 28, 29.

## Task 28: index format v3: format object, layout and dual-read readers

**Files:** `apps/mcp/src/search/format.js` (new), `apps/mcp/src/search/shards/serialize.js` (507 lines; manifest v4 codec), `apps/mcp/src/search/shards/io.js` (156 lines; dual read), `apps/mcp/src/search/shards/constants.js` (278 lines; v3 key builders beside the v2 constants), `apps/mcp/src/search/d1/backfill.js` (`loadCensus` reads `DOCMAP_KEY` at line 220; route through the layout), `apps/mcp/src/search/shards.js` (75 lines; re-exports), `apps/mcp/src/search/CONTRACT-v3.md` (new) and one line-neutral pointer in `CONTRACT.md`, tests `apps/mcp/test/searchFormat.test.mjs` (new).

**Data model.**

- Format: `{ tokenizer: 1 | 2, chunk: null | { target: number, max: number, cap: number } }`. `DEFAULT_FORMAT = { tokenizer: 1, chunk: null }` is today's index.
- **Ruling (controller, OPEN-56):** layout and dual reads. Recommend a separate namespace per format generation: today's v2 objects stay exactly where and how they are (`.context/search/v2/`, manifest version 3); any non-default format lives under `.context/search/v3/` with `manifest.json` at version 4 = the version 3 fields plus `format` (the object above) and `shards: [{ key, digest } | null]` (Task 31 fills it), `docmap.json` (unchanged shape), and shard revisions under `.context/search/v3/shards/`. A manifest whose `format` differs from the configured one is a rebuild of v3 (delete-the-manifest semantics, everything there is disposable). Readers: a v4 manifest is parsed only by this code; a v3-namespace reader given version 3 or older refuses it; today's gateway never looks under `v3/`, so a rollback of the code simply serves v2. Cost if wrong: one namespace per format means a format change costs a full v3 build while v2 keeps serving (two indexes stored during the switch); building in place instead would serve a mixed-tokenizer index during the rebuild, which no query can score consistently.
- Layout: `{ namespace: "v2" | "v3", manifestKey, docmapKey, shardKeyFor(id, manifest) }`; for v2 `shardKeyFor` is today's `shardKey(id)`; for v3 it returns `manifest.shards[id]?.key ?? null` (null means "nothing stored for this shard").

**API.**

- `indexFormatFor(source)` in `format.js`: reads `source.SEARCH_TOKENIZER` (`"1"` or `"2"`) and `source.SEARCH_CHUNK_CHARS` (`"0"` or absent = no chunking, `"1000"`, `"2000"`, `"4000"`), anything else means the default, never a throw (the `searchBudgetFor` rule, `search/budget.js:36`). `chunk.max` per OPEN-54, `chunk.cap` 64,000.
- **Ruling (controller, OPEN-57):** switch shape. Recommend the two vars above, unset in `[vars]` (production) and set only where an experiment wants them; the resolved format travels on the store as `store.searchIndexFormat` (Task 31), the same way `searchSubrequestBudget` does (`http/route.js:257`, `:467`). Default format means v2 namespace, so with nothing set no reader or writer behaves differently from today. Cost if wrong: renaming two vars.
- `formatUsable(format)`: true for the default; for anything else true when values are in range. Task 35 adds the segmenter gate here.
- `loadIndexManifest(store, budget, reserve, byteCap)` (`io.js:30`) keeps its signature and return for callers that pass nothing new; it gains reading of `store.searchIndexFormat`: when that is non-default and `formatUsable`, it reads the v3 manifest first and serves it if it parses, its `format` equals the configured one and it has completed at least one full pass (a `built: true` field set by the writer when `pending === 0 && !truncated` first holds); otherwise it reads and serves v2 exactly as today (the dual read). The returned manifest carries `layout` and `format` so callers never re-decide.
- `loadDocmapPaths` and `loadCensus` follow the same selection, so link resolution (Phase 3) and the graph census (Phase 2 Task 10) read the same namespace search serves.
- `fetchShardBytes`/`loadShard` take the key from `layout.shardKeyFor`; a null key reads as an empty shard.

**Ruling (controller, OPEN-72):** files over 700 lines. Recommend: edits to `sync.js`, `visible.js` and `CONTRACT.md` replace lines rather than add them (for example `MANIFEST_KEY` to `layout.manifestKey`); new prose goes to `CONTRACT-v3.md`, linked from `CONTRACT.md` by extending an existing line; if a task cannot stay line-neutral it stops and asks the controller, who inserts a pure extraction task (behavior-free move, own review). Cost if wrong: an extraction task appears mid-phase.

**Tests (write first).** v4 manifest round trip; v4 with an unknown `format.tokenizer`, a `shards` length unlike `shardCount`, or a non-string key is refused (`null`); a version 3 manifest under `v3/` is refused; `indexFormatFor` for absent, `"2"`, `"abc"`, `"2000"`, `"3000"`, `"0"`; dual read: with `store.searchIndexFormat` default, only `v2/` keys are read (wrap `get`, assert no `v3/` key); with tokenizer 2 configured and no v3 manifest, v2 is served; with a v3 manifest not yet `built`, v2 is served; with a built v3 manifest of a different format, v2 is served; with a built matching one, v3 is served and `loadDocmapPaths`/`loadCensus` read `v3/docmap.json`. Every key either layout produces is plumbing to `isPlumbing` and `defaultIsIndexable`. Sabotage: serve a v3 manifest whose `format` differs and the format-mismatch test fails; drop the `built` check and the not-yet-built test fails.

**Bench.** Default format: per-task bench check unchanged (no v3 key is read).

**Parallel:** group A, with Tasks 26, 27, 29.

## Task 29: graph-assisted ranking for search, off by default

**Files:** `apps/mcp/src/search/fuse.js` (new), `apps/mcp/src/graph/retrieve.js` (from Phase 3 Task 16; add `intent: "search"`), `apps/mcp/src/search/visibleNotes.js` (289 lines; the switch point), tests `apps/mcp/test/searchGraphFusion.test.mjs` (new).

**API.**

- `fuseRanks(lexical, graphLists, { pinned, k, weight })` in `fuse.js`: pure. `lexical` is the ranked visible lexical hit list; `graphLists` are independently ranked candidate lists (`links_here`, `linked_from_here`, `shares_target`, `shares_url`, `nearby`), each already visible-only.
- `retrieveCandidates(store, { seed: { query }, intent: "search", ... })`: lexical search first (`searchIndexedNotes`, unchanged), then graph neighbours of the top lexical hits via `graphNeighbors` (Task 15) under the same caller budget and visibility rules, then `fuseRanks`.
- **Ruling (controller, OPEN-67):** fusion design. Recommend: seeds are the top 3 visible lexical hits; graph reads only (node records and postings, no extra note bodies; outgoing targets from the seed's node record); reciprocal rank fusion with k = 60 (the OPEN-31 constant) and graph lists weighted 0.5 against lexical 1.0; the top 3 lexical hits are pinned in place (README 12.3: an exact lexical hit is never buried, graph expansion is never required for a lexical hit to survive); a candidate reached only through a hidden intermediary is impossible because `graphNeighbors` drops hidden entries before counting (README 12.4). Variants: `b2` = links and shared targets, `b3` = `b2` plus shared URL, `b4` = `b3` plus `nearby` (DELIVERY 17.1). All constants are named experiment parameters (README 12.3). Cost if wrong: retuned on the held-out set; no format change.
- **Ruling (controller, OPEN-68):** switch and wiring. Recommend `SEARCH_GRAPH_BOOST` (`"off"` default, `"b2"`, `"b3"`, `"b4"`) resolved onto `store.searchGraphBoost` in Task 31's `route.js` lines (Task 31 owns `route.js`; this task reads the field, absent means off), and wired in `searchVisibleNotes` (`visibleNotes.js`) rather than `visible.js`, which cannot grow. Off means `searchVisibleNotes` is byte-identical to today. When the graph is unavailable or `possiblyIncomplete`, the lexical answer is returned and labelled (Phase 3 and 4 constraint). Cost if wrong: the console path (Convex, which calls `searchIndexedNotes` directly) does not get graph boosts until wired separately.

**Tests (write first).** `fuseRanks`: pinned lexical hits keep positions 1 to 3 whatever the graph lists say; a graph-only candidate can enter only below them; deterministic tie-break by path. Through a projected graph on `memoryBucket()`: a note linked from the top lexical hit but lacking the query term is returned with `b2` and not with `off`; an unavailable graph returns the lexical answer unchanged plus the incomplete label; privacy invariance for a team caller (adding or removing a hidden note that links the seed, a hidden shared target, a hidden shared URL leaves the answer deep-equal); `budget.spent` never exceeds the budget; `off` answers equal today's byte for byte. Sabotage: unpin the lexical top 3 and the exact-hit test fails; count graph degree before `canSee` and the invariance test fails.

**Bench.** With `off`, per-task bench check unchanged. Graph arms measured in Task 38 only.

**Parallel:** group A (needs only Phase 3 and 4 code), with Tasks 26, 27, 28.

## Task 30: `tokenizeV2` and versioned `termsOf`

**Files:** `apps/mcp/src/search/text.js` (73 lines), tests `apps/mcp/test/tokenizerV2.test.mjs` (new).

**Data model.** A tokenizer version is the integer `1` (today) or `2`. A term is a string; `termsOf` returns terms in document order with repeats (term frequency is counted by the caller, as today).

**API.**

- `termsOf(text, tokenizer = 1)`: version 1 is today's `tokenize(text).map(stem)`, byte-identical. Version 2 is `tokenizeV2(text)`. `tokenize`, `stem` and `trigrams` keep their signatures and behavior.
- `tokenizeV2(text)` returns final terms (already stemmed where applicable), in this order (case is needed for camelCase, so lowercasing happens per word after splitting):
  1. NFKC normalize; replace U+2019 with `'` (controller ruling).
  2. Segment with `new Intl.Segmenter(undefined, { granularity: "word" })`, keep segments with `isWordLike`.
  3. Per word: identifier split (OPEN-50) on the original case; each emitted piece is lowercased, accent-folded (OPEN-49), length-filtered (OPEN-51), and stemmed with `porter2` when it is Latin script (`/^[a-z']+$/` after folding); other scripts unstemmed (P9).
  4. CJK runs also yield two-character pieces (OPEN-48).
- `porter2` re-exported from `text.js` (PLAN API names it there; the module stays `search/porter2.js`).
- `segmenterSelfTest()` returns `true` only when `Intl.Segmenter` exists and segments a fixed Chinese sentence from the bench fixtures (`数据库迁移计划已经确认` must yield a segment `迁移`) and keeps `fetchUserProfile` whole. Memoized per isolate. Task 35 gates on it.
- **Ruling (controller, OPEN-48):** CJK set and fallback. Recommend CJK = Han, Hiragana and Katakana (Hangul is space-delimited and the segmenter handles it). The index stores segmenter words plus overlapping two-character pieces of every CJK run; the query side emits only segmenter words, and a query word with no document frequency falls back to its two-character pieces required together, through the same "term found nothing" expansion hook prefix and trigram expansion already use in `shardQuery.js`/`query.js` (Task 33 wires it). Cost if wrong: CJK terms roughly double the CJK vocabulary in a shard (measured in Task 38 as shard count and bytes); querying bigrams always instead of on miss would rank segmentation-split matches equal to exact words.
- **Ruling (controller, OPEN-49):** accent folding. Recommend NFD then remove `\p{Mn}` only when the base letter is Latin script, then NFC; marks on other scripts are kept (Devanagari vowel signs and Thai vowels are `Mn` and carry meaning). Cost if wrong: folding everything mangles Thai and Indic words; folding nothing leaves `café` and `cafe` apart.
- **Ruling (controller, OPEN-50):** identifiers. Recommend: a word containing `_`, `.`, an internal lowercase-to-uppercase transition, or a letter/digit boundary inside a camelCase run emits the whole word (lowercased, not stemmed, not folded beyond step 1) and then its parts split on `_`, `.` and case transitions (`fetchUserProfile` to `fetchuserprofile`, `fetch`, `user`, `profile`; `MAX_RETRY_COUNT` to `max_retry_count`, `max`, `retry`, `count`; `v2.3.1` to `v2.3.1`, `v2`); parts are stemmed like any word. The query side runs the same function, so a query for the whole identifier also emits its parts. Cost if wrong: an unstemmed whole form misses `fetchUserProfiles`; a stemmed whole form can conflate two identifiers; either is a ranking difference, not a format change beyond a rebuild.
- **Ruling (controller, OPEN-51):** minimum length. Recommend keep today's `>= 2` code units for every script, applied after splitting. Cost if wrong: single-character Chinese words stay unsearchable as they are today (no regression), and the CJK two-character pieces cover most two-character words.
- **Ruling (controller, OPEN-52), gateway half:** when `Intl.Segmenter` is absent, `tokenizeV2` falls back to `[\p{L}\p{N}_.']+` runs plus the same CJK two-character pieces, and `segmenterSelfTest()` is `false`. Task 35 makes a writer or reader whose self-test fails refuse tokenizer 2, so fallback terms never meet segmenter terms in one index. Cost if wrong: a runtime that silently produced different terms for the same text would build an index its peer cannot hit.

**Tests (write first).** Version 1 output equals today's on the existing `text.js` checks and on every bench fixture note (`generateCorpus({ size: 100 })`). Version 2 cases: `数据库迁移计划已经确认` contains `迁移` and the piece `迁移`; Japanese `来週のリリース計画` contains `リリース`; a Thai sentence segments into more than one term and nothing is stemmed; `café`/`Café`/`cafe` give one term; `naïve` and `naive` equal; a Devanagari word keeps its vowel sign; `deploying`, `deployed`, `deployment` share a Porter2 stem as the page defines; `gateway's` and `gateway’s` (U+2019) give `gateway`; the four bench `CODE` identifiers emit their whole and split forms; fullwidth `ＡＢＣ` equals `abc`; `segmenterSelfTest()` true under Node. A test with `Intl.Segmenter` deleted (restored in `finally`) gets the fallback and `segmenterSelfTest() === false`. Sabotage: lowercase before identifier split and the camelCase test fails; fold marks on every script and the Devanagari test fails.

**Bench.** Not reachable from search yet (default 1); rerun the per-task bench check to show it unchanged.

**Parallel:** group B, after Task 26. Parallel with Task 31.

## Task 31: the v3 writer: revisioned shards, conditional publication, switch plumbing

**Files:** `apps/mcp/src/search/shards/sync.js` (885 lines; line-neutral), `apps/mcp/src/search/shards/placement.js` (248 lines; revision key), `apps/mcp/src/search/format.js` (from Task 28), `apps/mcp/src/http/route.js` (set `store.searchIndexFormat = indexFormatFor(env)` beside both `searchSubrequestBudget` lines), `apps/mcp/wrangler.toml` (commented, unset vars documenting the switch; staging per Task 35), the Convex search path (`apps/convex/functions/lib/fileOps/search.ts`: set the same field on the store it hands `syncShardedIndex`/`searchIndexedNotes`, from the Convex deployment's env; stop and ask if there is no single place), `CONTRACT-v3.md`, tests `apps/mcp/test/searchRevisions.test.mjs` (new).

**API.** `syncShardedIndex` reads `store.searchIndexFormat`; default format behaves exactly as today against `v2/`. Non-default and `formatUsable`: the same pass against the v3 layout, with these differences only:

- Each touched shard is written to a new revision key instead of `shardKey(id)`, and the manifest's `shards[id]` names that exact key and digest. Unchanged shards keep their entry.
- The manifest write stays the single commit point, conditional on the etag read at the top; on a missing manifest it is a create (`onlyIf: { absent: true }` where `store.capabilities.conditionalCreate`, else today's unconditional put). A pass whose manifest write loses leaves its revisions unreferenced (Task 32 collects them); it never overwrites an object the winning manifest references.
- `built` becomes true on the first pass that ends with `pending === 0 && !truncated` and stays true.
- **Ruling (controller, OPEN-58):** revision key and digest. Recommend `.context/search/v3/shards/<nnn>-<hex16>.json`, where `hex16` is the first 16 hex characters of `sha256Hex` of the serialized body (import `sha256Hex` from `ingestion/inbox.js:63` per OPEN-1), and `digest` in the manifest is the full 64-hex value; readers trust the key and do not re-hash. Cost if wrong: bucket-side corruption of a revision is caught only by the parse caps and the audit, as today.
- **Ruling (controller, OPEN-74):** revisioning applies to the v3 namespace only; the v2 writer keeps its unconditional fixed-key shard writes in Phase 5. README 12.6 requires coherence "before relying on routing to exclude a shard in the replacement design", which is v3. Cost if wrong: today's v2 index keeps the theoretical stale-filter window 12.6 describes until Phase 6 retires or migrates it.

**Tests (write first).** On `memoryBucket()` with conditional writes: default format writes only `v2/` keys (assert key set) and a v2 search result is byte-identical to before; tokenizer-1 v3 format builds an index whose search answers equal the v2 answers on the bench 100-note corpus (same tokenizer, no chunking: the namespace alone must not change results); two concurrent passes (interleave via wrapped `put`) leave a manifest where every `shards[id].key` exists, parses, and whose terms are exactly those the manifest's filter for `id` was built from (rebuild the filter from the referenced shard and compare bytes); the loser's revisions are not referenced; a pass never writes to a key any manifest already references; `built` flips once; budget exhaustion leaves the previous manifest and its revisions readable. On `memoryBucket({ ignoreIfMatch: true })`: the pass completes and labels nothing new (coherence is not claimed there; `indexIncomplete` semantics unchanged). Sabotage: write the revision to a fixed key and the concurrent-coherence test fails; reference the revision before the manifest write is confirmed and the loser test fails.

**Bench.** Per-task bench check with switches off. Also run once with `SEARCH_TOKENIZER=1`, `SEARCH_CHUNK_CHARS=0` forced to v3 through a bench option (Task 37 adds the flag; until then a one-off local edit, not committed) and confirm B0 quality rows equal BASELINE; subrequests per query reported, since revisioning adds no read per query.

**Parallel:** group B, after Task 28. Parallel with Task 30.

## Task 32: garbage collection of unreferenced shard revisions

**Files:** `apps/mcp/src/search/shards/gc.js` (new), `apps/mcp/src/search/maintenance.js` (408 lines plus Phase 2's graph call; one guarded call), `CONTRACT-v3.md`, tests `apps/mcp/test/searchRevisionGc.test.mjs` (new).

**API.** `collectShardRevisions(store, budget, { manifest, now })`: lists `.context/search/v3/shards/` one bounded page per call from a cursor, deletes revisions that the current manifest does not reference and whose `uploaded` is older than the retention window; never touches any key outside that prefix.

- **Ruling (controller, OPEN-59):** retention and placement. Recommend retention 15 minutes (a named constant with a `lean:` comment: well past any Worker request's wall time, so an in-flight reader that pinned the previous manifest still finds its revisions), at most one listing page and its deletes per maintenance pass, called from `maintainNow` after the search sync and before the graph pass, only when a v3 manifest is being served and `budget.remaining` exceeds a floor of 2. A listing missing `uploaded` deletes nothing (unknown age is kept). Cost if wrong: stale revisions accumulate (storage only) if too timid; an in-flight reader sees a missing shard and reports `indexIncomplete` if too eager.

**Tests (write first).** Referenced revisions are never deleted; an unreferenced revision younger than the window survives; an older one is deleted; a missing `uploaded` survives; `.context/search/v2/`, `.context/graph/` and note keys are never listed or deleted (wrap `delete`, assert prefix); budget respected (assert `spent`); a GC failure does not change the maintenance result. Sabotage: widen the prefix to `.context/search/` and the v2-untouched test fails; ignore `uploaded` and the young-revision test fails.

**Bench.** Not on the query path; per-task bench check unchanged.

**Parallel:** group C, after Task 31. Parallel with Tasks 33, 34, 35.

## Task 33: tokenizer version on both sides of the index, and chunk-aware ranking

**Files:** `apps/mcp/src/search/indexer.js` (528 lines; `addDoc` gains `tokenizer`), `apps/mcp/src/search/query.js` (536 lines; `parseQuery(query, tokenizer)`, `rankedVisibleTo` dedupe, CJK miss fallback), `apps/mcp/src/search/shardQuery.js` (536 lines; the same fallback in the shard scorer), `apps/mcp/src/search/resultText.js` (32 lines; `snippetLinesFor(text, terms, tokenizer)`), `apps/mcp/src/search/visible.js` (812 lines; line-neutral: pass `manifest.format.tokenizer` at `parseQuery` (line 386) and both `snippetLinesFor` calls (591, 607)), `apps/mcp/src/search/shards/sync.js` (line-neutral: pass `format.tokenizer` into the `addDoc` call), `CONTRACT-v3.md`, tests `apps/mcp/test/searchTokenizerSwitch.test.mjs` (new).

**API.**

- `addDoc(index, path, { ..., tokenizer = 1, chunk = null })` uses `termsOf(field, tokenizer)` for every field and stores `chunk` on the doc entry when given. `parseQuery(query, tokenizer = 1)` and `snippetLinesFor(text, matchedTerms, tokenizer = 1)` likewise. Defaults keep every existing caller identical.
- CJK fallback (OPEN-48): a query term containing CJK with zero visible document frequency is replaced by its two-character pieces, required together, before prefix and trigram expansion are considered.
- **Ruling (controller, OPEN-61):** chunk ranking. Recommend: score each chunk as a document; in `rankedVisibleTo`, after the visibility filter, keep the best-scoring chunk per `notePath` among docs that carry `chunk` (channel-day message docs are untouched: each stays its own result, as today); the kept entry carries the union of `matchedTerms` over that note's chunks so the snippet can quote any matching line. Counts derived from `rankedVisibleTo` are therefore notes (README 12.5). Cost if wrong: a query whose terms fall in two different chunks of one note scores lower than in a whole-note index (the coverage multiplier applies per chunk); Task 37's held-out set includes such a case so the bench shows the size of it.

**Tests (write first).** Through a real build and `searchIndexedNotes` on `memoryBucket()` with tokenizer 2 (format forced on the store): each Task 30 case is found by the query that names it (Chinese, Japanese, Thai, accents, identifiers) and the query's terms equal what the indexer stored for that text (identical between indexer and query, PLAN Tests); with tokenizer 1 the same queries give today's answers. Chunk dedupe: a note with 5 matching chunks is one hit and `matchCount` counts it once; two notes each with matching chunks are two hits ordered by best chunk; a channel-day note's two matching messages are still two hits. A forbidden note's chunks never appear and never change the visible answer (privacy invariance with and without the hidden note). The result key for a chunk hit is the note path (never `path#c<n>`), so `read_note` accepts it. Sabotage: parse the query with tokenizer 1 against a tokenizer-2 index and the Chinese test fails; dedupe before the visibility filter and the privacy test fails; dedupe message docs and the channel-day test fails.

**Bench.** Per-task bench check with switches off (defaults keep B0 identical).

**Parallel:** group C, after Tasks 28, 30 and 31. Parallel with Tasks 32, 34, 35 (shares no file with them).

## Task 34: the app's local search on the shared tokenizer

**Files:** `apps/mobile/features/home/localSearch.ts` (86 lines), `apps/mobile/__tests__/homeLocalSearch.test.ts` (existing cases unchanged; new cases added).

**Behavior today.** Case-insensitive substring match over in-memory notes, titles before bodies (`searchLocalNotes`); it shares no index with the gateway.

- **Ruling (controller, OPEN-62):** parity. Recommend: import `termsOf` and a single exported constant `DEFAULT_TOKENIZER` (value 1) from `../../../mcp/src/search/text.js` (the app already imports gateway source this way, `features/home/useLocalFolderLists.ts:2`); match when every query term is a prefix of some term of the title (title hit) or body (body hit), terms from `termsOf(..., DEFAULT_TOKENIZER)`; the snippet window centers on the first line whose terms match. Flipping `DEFAULT_TOKENIZER` (Task 39, owner-approved) then flips the gateway default and the app in one change. Cost if wrong: token-prefix matching loses infix substrings (`ate` no longer finds `private`), a visible behavior change on the homepage the day the constant flips; keeping substring matching instead means the app never gains CJK or stemming.
- **Ruling (controller, OPEN-52), app half:** Hermes (native) support for `Intl.Segmenter` is not verified. Recommend relying on Task 30's fallback (regex runs plus CJK pieces) when it is absent; the app builds no shared index, so a divergence there changes only its own answers. Cost if wrong: Chinese matching on native differs from web.

**Tests (write first).** The six existing tests pass unchanged with `DEFAULT_TOKENIZER` at 1 (assert this, since token-prefix must still find `pri` in `Pricing` and `private`); with the tokenizer forced to 2 in the test: `迁移` finds a note containing `数据库迁移计划`, `deploying` finds `deployed`, `user profile` finds `fetchUserProfile`. Sabotage: match on the whole query string instead of terms and the identifier test fails.

**Bench.** Not part of the bench harness (no index); jest only. Report `pnpm --filter @context/mobile test` totals.

**Parallel:** group C, after Task 30. Parallel with Tasks 32, 33, 35.

## Task 35: the segmenter gate and the staging check

**Files:** `apps/mcp/src/search/format.js` (`formatUsable`), `apps/mcp/wrangler.toml` (`[env.staging.vars]`), `scripts/staging-cli-live.mjs` (202 lines), `docs/design/link-graph/BASELINE.md` (the "Intl.Segmenter" paragraph, after the check has run), tests extend `apps/mcp/test/searchFormat.test.mjs`.

- `formatUsable(format)` returns false for `tokenizer: 2` when `segmenterSelfTest()` (Task 30) is false. Because the reader and the writer both consult it (Tasks 28, 31), a runtime without a working segmenter neither writes nor queries a tokenizer-2 index; it serves v2.
- **Ruling (controller, OPEN-52), Convex half:** whether Convex's runtime has `Intl.Segmenter` is unverified; with this gate it either has it (and agrees with the gateway) or serves v2. Cost if wrong: none for correctness; console search stays on v2 while agents get v3.
- **Ruling (controller, OPEN-63):** the staging check BASELINE defers ("its first staging deploy carries a check that it segments Chinese before the switch is turned on"). Recommend: set `SEARCH_TOKENIZER = "2"` (and `SEARCH_CHUNK_CHARS` per the arm Task 38 selects, else unset) in `[env.staging.vars]` only, never in `[vars]`; extend `staging-cli-live.mjs`, which already signs in as the seeded persona, writes and archives a capture note against `https://mcp-staging.context.lc/mcp`, with: write a note containing `数据库迁移计划已经确认` and a unique fake marker, then call `search_notes` for `迁移` with bounded retries while the v3 index builds, assert the note is a hit, archive it. A v1 tokenizer cannot pass this (the run is one token), so a pass proves the deployed Worker segments Chinese end to end. Running it is the controller's or owner's action through the existing `cli-live-staging.yml`; this task writes it. Cost if wrong: the CLI live job now also fails on a search-index regression, which mixes two concerns in one job.

**Tests (write first).** With `Intl.Segmenter` deleted, `formatUsable({ tokenizer: 2, ... })` is false and a configured tokenizer-2 store reads and writes only `v2/` keys; with it present, true. The live script is not run in CI unit tests; its new assertions are reviewed by reading. Sabotage: drop the self-test from `formatUsable` and the deleted-segmenter test fails.

**Bench.** Per-task bench check unchanged. The staging result (pass or fail, date, deployment) is recorded in BASELINE.md's Intl.Segmenter paragraph, replacing "Not yet checked on deployed staging" only after a real run.

**Parallel:** group C, after Tasks 30 and 31. Parallel with Tasks 32, 33, 34.

## Task 36: chunked sub-documents and the 64,000-character cap in the sync

**Files:** `apps/mcp/src/search/commsIndex.js` (361 lines; generalize `subDocumentsFor` and `indexVolumeOf`), `apps/mcp/src/search/shards/sync.js` (line-neutral: pass the format to `subDocumentsFor` at line 631 and `indexVolumeOf` at line 340), `apps/mcp/src/search/shards/maintenance.js` (288 lines; `statsOfShard` sparse `partialPaths`), `apps/mcp/src/search/shards/serialize.js` (`partialPaths` in stats, sparse, like `shedPaths`), `apps/mcp/src/search/shards/shapes.js` (136 lines; `shedNotePathsOf` includes `partialPaths`), `CONTRACT-v3.md`, tests `apps/mcp/test/searchChunks.test.mjs` (new).

**API.**

- `subDocumentsFor(path, full, format = DEFAULT_FORMAT)`: channel-day notes unchanged (per-message documents, per-message cap). An ordinary note with `format.chunk` set yields one document per `chunkNote` chunk (Task 27); without it, today's single capped document.
- **Ruling (controller, OPEN-53):** chunk doc fields. Recommend `{ key: "<path>#c<index>", notePath: path, anchor: null, chunk: index, content, comms: null }`: `anchor` stays null because `visible.js` routes any string anchor to `messageSegmentFor` and would drop the hit; `chunk` is what Task 33 dedupes on. `content` for chunk 0 is the chunk text; for later chunks it is the note's first heading line (when the note has one) followed by the chunk text, so `extractFields` gives every chunk the note's title rather than a section heading or the filename; tags come from frontmatter in chunk 0 only. Cost if wrong: title terms count once per chunk (the note keeps its best chunk, so ranking moves only within the bench's title class, which Task 38 reports).
- **Ruling (controller, OPEN-60):** placement and volume. Recommend chunked ordinary notes keep hash placement (`fnv1a32`), and `indexVolumeOf(path, size, format)` counts an ordinary note as `min(size, format.chunk ? format.chunk.cap : NOTE_INDEX_CHAR_CAP)`, so `chooseShardCount` sees long notes' real volume. Bundled placement stays path-decided (`isBundledIndexPath`). Cost if wrong: a shard holding several long notes sheds (reported, never silent) instead of being placed elsewhere; Task 38 reports shard count, shed and oversized shards per arm.
- **Ruling (controller, OPEN-55):** `partial`. Recommend: the last chunk of a capped note carries `partial: true`; `statsOfShard` collects those notePaths into a sparse `partialPaths`; `shedNotePathsOf` returns shed and partial paths together, so the existing visibility-filtered `reducedRecall`/`reducedRecallNotes` path in `visible.js` reports them with no edit there. Cost if wrong: the caller-facing wording says "reduced recall" for both causes; a distinct label is a later wording change, no format change.

**Tests (write first).** With `chunk: { target: 2000, max: 3000, cap: 64000 }`: a 20,000-character note becomes about 10 docs, all with the note's `notePath` and the same version in the docmap, and a term at character 15,000 is found; a term past 64,000 is not found and the note appears in `reducedRecallNotes` for an owner and not for a caller who cannot see it; editing the note to fewer chunks removes the old chunk docs (`removeDocsForNote`); a channel-day note produces exactly today's message docs; an encrypted note produces no plaintext term (CONTRACT.md "Encrypted notes teach the index nothing"); with `chunk: null` every doc equals today's. Sizing: `indexVolumeOf` of a 50,000-byte ordinary note is 50,000 with chunking and 2,048 without. Sabotage: set `anchor` to `c<n>` and the found-past-15,000 test fails at snippet time; drop the docmap version for chunk docs and the diff-converges test (second pass touches nothing) fails.

**Bench.** Per-task bench check with switches off. Expectation to record for Task 38, not to tune against: with chunking on, the `deep` class should find the four notes under 64,000 characters and report the two past it as partial.

**Parallel:** group D, after Tasks 27 and 33 (and so after 31). Sequential with Task 33 on `sync.js`.

## Task 37: bench harness for the ablation matrix and the held-out set

**Files:** `apps/mcp/bench/run.mjs` (295 lines; engine options), `apps/mcp/bench/fixtures.js` (224 lines; held-out generator), `apps/mcp/bench/engines.mjs` (new, if `run.mjs` would pass 500 lines), `apps/mcp/test/benchHarness.test.mjs` (91 lines).

**API.** New flags: `--format tok1|tok2`, `--chunk 0|1000|2000|4000`, `--graph off|b2|b3|b4`, `--set judged|heldout`, `--engines B0,B1,...`. Each engine is the real code with the store fields set (`searchIndexFormat`, `searchGraphBoost`); graph arms build the graph with Phase 2's `reconcileGraph` on a bench bucket that advertises `capabilities: { conditionalWrite: true, conditionalCreate: true }` and honours `onlyIf.absent` (the current bench bucket honours only `etagMatches`). Output adds per arm: shard count, index bytes, shed and oversized shards, notes reported partial, build passes, and subrequests per query against both the free-tier 50 and the hosted 600 ceilings (DELIVERY 16.3).

- **Ruling (controller, OPEN-64):** held-out set. Recommend `generateHeldOut({ size, seed: 2 })` in `fixtures.js`: the same classes with different planted words (new morphology families, CJK sentences, identifiers, exact and deep markers), written once and frozen before any tuning (DELIVERY 17.5); `generateCorpus({ size, seed: 1 })` stays byte-identical so BASELINE.md and the P3 thresholds keep their meaning. Constants (chunk size choice, fusion weights) may be compared on the seed-1 set; the switch decision is made on the held-out set only. Cost if wrong: a 41-query set tuned and judged on itself overstates a win.
- **Ruling (controller, OPEN-65):** link-dependent queries. BASELINE's classes contain none where a link supplies the answer, so B2 versus B1 would read zero by construction. Recommend adding to the held-out set only a `linked` class (a query term appears in note A; note B, which A links to and which lacks the term, is also relevant; relevant = [A, B]) and a `crosschunk` class (two query words in one long note, more than one chunk apart; relevant = that note), both from DELIVERY 17.3's "questions requiring more than one note"; and none to the seed-1 set. Cost if wrong: the graph arm is judged on synthetic link structure that favours it; the per-class table keeps it from hiding behind the average (DELIVERY 17.3).
- **Ruling (controller, OPEN-75):** matrix arms. Recommend B1 = v3 format, tokenizer 1, chunking at 2,000; the chunk sweep (1,000, 2,000, 4,000) at tokenizer 1; B1+T2 = the chosen chunk size with tokenizer 2; B2, B3, B4 = graph arms on top of whichever lexical arm (B1 or B1+T2) Task 38 selects; B0 and B5 unchanged. All at 100, 1,000 and 10,000 notes on both sets. Cost if wrong: a tokenizer and chunk-size interaction is not measured (one extra run if needed).

**Tests (write first).** Held-out generator determinism (same seed, same corpus) and disjointness from seed 1 (no planted query word shared); `generateCorpus({ size: 1000 })` unchanged (hash of its output pinned in the test); the `linked` relevant pairs exist and B is linked from A; metric functions unchanged. Sabotage: let the held-out generator reuse `FAMILIES` and the disjointness test fails.

**Bench.** Run `--engines B0,B5 --set judged --sizes 100,1000` and confirm BASELINE rows reproduce through the new flags (proves the flags do not change the default engines).

**Parallel:** group E, after Tasks 29, 33 and 36.

## Task 38: run the matrix and report

**Files:** `docs/design/link-graph/RESULTS.md` (new), `docs/design/link-graph/BASELINE.md` (only the Intl.Segmenter paragraph if Task 35's staging run happened in this window).

- Run every arm of OPEN-75 at 100, 1,000 and 10,000 notes on both sets with the BASELINE latency settings (20 ms, budget 600). Report each table in BASELINE's format plus the per-arm index costs Task 37 prints, the per-class table, B2 versus B1 called out as the graph-value comparison (DELIVERY 17.3), and the P3 table at 10,000 notes (Recall@10 at least 0.66, nDCG@10 at least 0.66, subrequests beside it).
- **Ruling (controller, OPEN-66):** what counts as a win for switching an arm on (P9). Recommend, on the held-out set at 10,000 notes: Recall@10 and nDCG@10 both strictly higher than the arm it builds on; no query class lower by more than 0.05 Recall@10, and `exact` and `title` stay at 1.00 (DELIVERY 17.3: no hiding behind the average); warm p95 and subrequests per query no more than 10% higher; no increase in shed or oversized shards at 10,000 notes. Chunk size: the smallest size meeting the rule, 2,000 on a tie (P8's default). Cost if wrong: with 41-odd queries per set, p95 is the second-highest sample (BASELINE "Percentiles are coarse"), so a latency regression under 10% is noise-level either way.
- **Ruling (controller, OPEN-69):** the P3 latency gate needs staging R2 and D1 round trips (BASELINE "P3 thresholds"). Recommend not measuring them in Phase 5 unless the owner schedules a staging measurement; RESULTS.md reports latency under the 20 ms assumption and states the gate as not yet decidable. Cost if wrong: Phase 6 cannot apply P3's latency gate without a further measurement step.
- **Ruling (controller, OPEN-70):** where results live. Recommend a new `RESULTS.md` beside BASELINE.md, leaving BASELINE.md as the preregistered Phase 0 record (its thresholds were "recorded before tuning"). Cost if wrong: one file merge.

**Tests.** None new. The report names the exact command for every table and the commit it ran on; a reviewer reruns one 1,000-note arm and gets the same quality columns.

**Parallel:** group F, after Tasks 32, 34, 35 and 37.

## Task 39: record Phase 5 and hand off to Phase 6

**Files:** `docs/decisions/search.md` (99 lines; tokenizer v2, chunking, index format v3, revision GC), `docs/decisions/link-graph.md` (from Task 12; graph-assisted ranking), `docs/decisions/README.md` (only if an index line is needed); and, only with the owner's explicit approval at review, the default flips (OPEN-73).

- Decisions recorded in the existing format (what reversing costs, the test that fails, with real test file and check names from Tasks 28, 31, 36, 33, 29).
- **Ruling (controller, OPEN-71):** per-language stemming. P9 says revisit after Phase 0 measures note languages; Phase 0 measured only synthetic fixtures, and the census of a real workspace runs only on request (PLAN Phase 0, `--census`). Recommend recording "not revisited: no real-workspace census was run" and leaving other scripts unstemmed. Cost if wrong: non-English morphology recall stays where it is until someone runs the census.
- **Ruling (controller, OPEN-73):** flipping a default. Recommend: when Task 38's rule is met, the flip is a separate commit at the top of the Phase 5 branch (`DEFAULT_TOKENIZER` in `text.js`, the default format in `format.js`, `SEARCH_GRAPH_BOOST` default), proposed in the PR and applied only on the owner's explicit approval; otherwise the PR ships every switch off. Production `[vars]` are never set by Phase 5. Cost if wrong: a reviewer approves the PR without noticing it changes default search.
- Phase 6 handoff in the PR text: the matrix and the P3 table at 10,000 notes (RESULTS.md); which switches are on; the v3 format's coherence test (README 12.6 gate) and its GC; the staging segmenter result; what is not measured (staging latencies, real-provider runs, agent-task A0/A1 arms of DELIVERY 17.1, cost totals of DELIVERY 16.2). PR text separates unit, runtime and live evidence (PLAN "Across every phase").

**Tests.** None new; named tests must exist and pass. **Parallel:** last in Phase 5.

---

## Dependency order and parallel groups

| Group | Tasks | Starts after |
|---|---|---|
| A | 26, 27, 28, 29 | Phase 4 merged into the Phase 5 base |
| B | 30 (after 26), 31 (after 28) | the group A task named |
| C | 32 (after 31), 33 (after 28, 30, 31), 34 (after 30), 35 (after 30, 31) | the group B tasks named |
| D | 36 (after 27, 33) | 33 |
| E | 37 (after 29, 33, 36) | 36 |
| F | 38 (after 32, 34, 35, 37) | 37 |
| G | 39 | 38 |
