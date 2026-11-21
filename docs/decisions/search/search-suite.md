# Search — the Search suite and its gate

### Search is measured on three sets, and a search change merges only if the right note stays first

Decided by the owner, 2026-11-21: "We really have to improve our search quality ... first and foremost, we do need to
start benchmarking our search results", and the plan "Bench + Search graph + gate" he approved the same day. Until
then the only search benchmark was `ai/tests/search.md`: 59 made-up questions where 87% already came back first, so it
said "fine" while real searches failed. The case that showed it: "public worship reading list" put the person's
reading list first when searched in their own workspace, and 12th of 12 across their six, behind a saved assistant
session that quoted the question.

**One harness, three sets** (`apps/mcp/bench/evals/searchSuite.mjs`). A case is one `search_notes` call as a bench
person through the MCP endpoint, in a warm bench world with both indexes filled, its own notes laid over the bench's
workspaces so it always searches a world of many notes. Only the embedder is called; a run costs embeddings and
seconds, never Claude.

- **Made-up hard** (`search-hard`, `apps/mcp/bench/search/hard/`): 40 questions as Priya, who reaches seven
  workspaces, each of a kind that beats a word match: notes that quote the question, the same words in another
  workspace, an answer deep in a long note, an archived copy, a paraphrase, a title, a person, a date, a link, a near
  duplicate. Question 1 is the reading-list miss, rewritten.
- **Real queries** (`search-real`): searches that really failed, rewritten, never verbatim. The search quality log
  (`searchTimings`, [search-timings](./search-timings.md)) keeps no query by design, so the source is Tex's own
  logged tool calls: a note search that Tex searched again without opening a hit, or never opened, with the note it
  finally opened as the answer. Each case brings made-up notes of the same shape (the target and what outranked it).
  Split 60/20/20: Training and Dev in `apps/mcp/bench/search/real/{training,dev}.json`, visible; Test sealed in the
  eval service. Its Dev part is the Lab's to run; the Test part never is.
- **LongMemEval retrieval** (`longmemeval-retrieval`, `memoryRetrieval.mjs`): every past session of a LongMemEval S
  question saved as a dated note in an empty workspace; are the answer sessions in the top 5 (recall any and all @5)?
  No reader, no judge; abstention questions have nothing to find and are left out.

**Scores:** right note first (the north star), in the top 5, found, mean reciprocal rank, median and 95th percentile
time. The goal is 90% right note first and 97% in the top 5 on the real Test part, and a median under 0.5 s.

**In the Lab** (Evals tab, "Search"; `tex_dev` `evals`/`eval_run`, the same numbers): any of the three sets on main's
code or a pull request's, through `.github/workflows/lab-eval-run.yml` (`cli.mjs search`). The real set's Test part is
not offered.

**The gate.** "Tex replay required" (`.github/workflows/tex-replay-check.yml`) also runs `scripts/search-test-set.mjs
gate`: a change that reaches search (`SEARCH_PATHS`: `apps/mcp/src/search/`, the search tools, the workspace object's
word and meaning indexes, and the search config graph under `packages/search/` once it lands) passes only on a
successful `Search test set` status on its head commit. The same check dispatches `search-test-set.yml` on main for it.
That run takes the Test part from the eval service by GitHub OIDC (doors `search-run` and `search-seed`, main's files
only, capped as the Tex Test Set is), ranks it on the change and on main with main's bench harness laid over both
trees (so a change can alter what search ranks, never how a rank is read), sends back only `{ id, rank }` rows, and
the service passes it when right note first on the change is no lower than on main. Logs carry counts only. The Test
part moves in once from `@context-lc ai/search-held-out/test.md` through `search-test-set-seed.yml`, which then empties
and archives that note.

**Both paths, per query.** The bench world searches buckets with a search database; production's workspaces whose home
is `object` answer from their workspace objects. So each case of the made-up and real sets is also searched in an
object world (`apps/mcp/bench/evals/objectWorld.mjs`): every bench workspace in the real `WorkspaceStore` Durable
Object over an in-memory SQLite, with its rows, text, rules, members, sealed binding and both indexes built, and each
person's own object holding their reach and a connection, searched through the same MCP endpoint. A run reports the
object world's scores beside the database's, and how many cases ranked the same, better or worse there
(`--database-only` skips it). The gate still reads the database world's rank. Each search records which way it was answered
(`pathOf`, from the gateway's own `event: "search"` trace: `object`, `database`, `index` or `scan`, and the object's
word when it declined, such as `catching_up`), and every run says how many went each way, so a score is never read
as the other path's.

**The public standard: NanoBEIR** (owner, 2026-11-21: "we should probably have a thread focused on bringing in a
popular search benchmark instead of our own"; `apps/mcp/bench/evals/nanoBeir.mjs`). Our own sets can only measure
what we thought to write down, and nobody outside can compare a number from them. BEIR is the field's standard
zero-shot retrieval benchmark (MTEB's retrieval tab is BEIR), scored by nDCG@10; NanoBEIR cuts 13 of its sets to 50
queries and a few thousand documents each, every judged document kept and BM25's top hits as distractors, and is what
Sentence Transformers' `NanoBEIREvaluator` reads. We read its `sentence-transformers/Nano<Set>-bm25` copies (their parquet files
from the Hugging Face Hub, at the revision it names), because they also carry BM25's own ranking of every query: the same judgements scored on
that list are the reference row beside ours, so "better than BM25" is a measured claim. Each set is its own world: Sam's
empty personal workspace, every document a note (`beir/<doc id>.md`), searched through the MCP endpoint on both paths.
The headline is nDCG@10 averaged over sets (NanoBEIR's own), beside Recall@10, MRR@10 and our right note first.
In the Lab: `nanobeir` (all 13, 649 queries) and `nanobeir-gate` (MS MARCO, NQ, FiQA, SciFact: short searches, plain
questions, forum-style answers and claims, the four nearest to what people and agents type into notes search; 200
queries over about 17,600 notes). **It joins the gate, it does not replace it:** a public set cannot be sealed, so a
change could be tuned to it, and it knows nothing of several workspaces, archives or notes that quote the question,
which is where our searches fail. So "Search test set" passes only when the sealed part's right note first does not
drop AND neither path's NanoBEIR nDCG@10 (database and workspace object) falls more than 0.005 below main's
(`BEIR_TOLERANCE`: about two queries each moving one place). Main ranks first and keeps every embedding it asked for in
a file (`BENCH_EMBED_CACHE`, saved to the Actions cache before the change runs); the change reads a copy, so its
code never writes what main reads, and the corpus is embedded once rather than on every gate run.

**What a simplification would cost:** a gate on the made-up set alone tunes search to questions we wrote; a Test part
an agent can read is tuned against; letting a change's own harness read its ranks lets it grade itself. **Tests:**
`apps/mcp/bench/test/searchHard.test.mjs`, `nanoBeir.test.mjs` (BEIR's nDCG, the mean over sets, the fetch, the embedding file), `memoryRetrieval.test.mjs`, `searchSuite.test.mjs`,
`scripts/search-test-set.mjs --self-test` (the paths, the gate, answers carry no words), `infra/tex-eval`'s search
tests (doors, caps, verdict), and `apps/convex/__tests__/controlPlane/labEvals.test.ts`.
