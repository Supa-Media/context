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

- **Made-up hard** (`search-hard`, `packages/bench/benchmarks/search-hard/`): 40 questions as Priya, who reaches seven
  workspaces, each of a kind that beats a word match: notes that quote the question, the same words in another
  workspace, an answer deep in a long note, an archived copy, a paraphrase, a title, a person, a date, a link, a near
  duplicate. Question 1 is the reading-list miss, rewritten.
- **Real queries** (`search-real`): searches that really failed, rewritten, never verbatim. The search quality log
  (`searchTimings`, [search-timings](./search-timings.md)) keeps no query by design, so the source is Tex's own
  logged tool calls: a note search that Tex searched again without opening a hit, or never opened, with the note it
  finally opened as the answer. Each case brings made-up notes of the same shape (the target and what outranked it).
  Split 60/20/20: Training and Dev in `packages/bench/benchmarks/search-real/{training,dev}.json`, visible; Test sealed in the
  eval service. Its Dev part is the Lab's to run; the Test part never is.
- **LongMemEval retrieval** (`longmemeval-retrieval`, `packages/bench/benchmarks/longmemeval/`): every past session of a LongMemEval S
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
(`--database-only` skips it).

**The object path alone, since 2026-11-22** (Dev2: "why do we still have two different types of search?"). Every
managed workspace searches in its object since 2026-11-20, so a run builds and searches the object world only, and
its headline (`ndcg10`, right note first) and the gate (the sealed part's rank) read
the object path. `--with-database` adds the bucket world and its search database back, which is how the four
bring-your-own-storage workspaces still search until they get objects of their own. Each search records which way it was answered
(`pathOf`, from the gateway's own `event: "search"` trace: `object`, `database`, `index` or `scan`, and the object's
word when it declined, such as `catching_up`), and every run says how many went each way, so a score is never read
as the other path's.

**The public standard: NanoBEIR** (owner, 2026-11-21: "we should probably have a thread focused on bringing in a
popular search benchmark instead of our own"; `packages/bench/benchmarks/nanobeir/`). Our own sets can only measure
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
queries over about 17,600 notes). **It is no longer in the gate** (owner, 2026-11-23: "we aren't even using nanobeir
anymore are we?"): it measures clean single-kind corpora, not the notes people keep, and a HuggingFace outage on main's
side failed a change that ranked better. "Search test set" passes when the sealed part's right note first does not drop.
NanoBEIR stays in the Lab as a benchmark to read.

**A run that gave no verdict frees its commit.** The eval service counts a commit's search run once it gave a verdict
or while it may still be running (`UNFINISHED_AFTER_MS`, 90 minutes, past the job's 75-minute timeout). A run that ended
with none told nobody anything about the cases, so the commit may run again without a person allowing it
(`infra/tex-eval/src/searchStore.ts`; test "caps search runs on search runs only").

**Messy workplace data: HERB** (owner, 2026-11-21: "look for a new benchmark public that's better suited", then
"ok, let's use herb then and see where we fall"; `packages/bench/benchmarks/herb/`). NanoBEIR's corpora are clean, one
kind of text per set; our real searches lose to clutter (chat, transcripts, forwarded mail, logs sharing one word with
the question). HERB (Salesforce AI Research, EMNLP 2025, arXiv 2506.23139) is 30 made-up products' Slack messages,
meeting transcripts, documents, links and pull requests, 39,772 artifacts, with 815 questions about content, people,
customers, pull requests and links, each citing the artifacts it is answered from. One world holds every artifact as
a note (the paper's pool is one), plus the people and customer profiles; the products' own team and customer lists are
left out, as the dataset card says a retrieval run must. Scored like NanoBEIR, a cited artifact being a relevant note,
per question type; a question cites a median of 52 artifacts, so nDCG@10 and right note first are the numbers to
compare, not Recall@10. Its licence is CC BY-NC 4.0: the data is downloaded at run time and never kept here, and only
our numbers are published. In the Lab as `herb` (815 questions). It is a measure, not part of the gate.

**The measure we keep: EnterpriseRAG Notes** (owner, 2026-11-21: "make sure HERB can be the final benchmark we need,
i don't want to have to change benchmarks again", then "we don't save emails in context anymore though, or even chat
threads"; `packages/bench/benchmarks/enterprise-rag-notes/`). HERB's licence is non-commercial and two thirds of it is
chat. EnterpriseRAG-Bench (Onyx, arXiv 2605.05253, MIT) is one made-up company's data from nine tools, 511,962
documents and 500 questions, each citing the documents that answer it, about 8% filed in the wrong tool on purpose.
Its Slack and Gmail documents are left out, and every question citing one: Context saves neither. The rest is filed
where Context keeps it, in PARA's folders (wiki and docs under `resources/`, meetings under `inbox/meetings/`, issues
and pull requests under `projects/`, customer records and support tickets under `areas/`): 104,967 documents and 343
questions. Because it is cut, its name says so and its scores are not the leaderboard's. The documents file (1.4 GB,
sorted by tool) is read with HTTP range requests, only the kept tools' rows, and kept as BEIR files in the run's
folder. `enterprise-rag-notes` searches 10,000 of the notes (every cited one, then per tool the documents whose titles
share the most words with that tool's questions, the hard distractors, the same every run);
`enterprise-rag-notes-full` searches all of them, which takes hours of embeddings. Scored like NanoBEIR, per question
type. It is a measure, not part of the gate. `enterprise-rag-notes-split` (owner, 2026-11-22: search "treats workspaces
as equal" instead of ranking which one a query belongs to) is the same 10,000 notes across four workspaces the searcher
reaches: their own (meetings) and three shared ones (engineering's issues, tickets and pull requests; the wiki and
docs; sales' customer records). Each search names no workspace, so it measures ranking across workspaces, which every
other benchmark here, one workspace each, cannot.

**Every benchmark is a folder** (owner, 2026-11-21: "we are going to be creating a lot of custom bench marks
internally ... define new bench marks in folders", "we love to reuse formats for all of our benchmarks").
`packages/bench/benchmarks/<id>/` holds `bench.json` (what it is, its licence, how it is scored, its runs) and
`source.mjs` (how it reads its data). The data is BEIR's open layout (`corpus.jsonl`, `queries.jsonl`,
`qrels/test.tsv`), with optional fields for what BEIR cannot say: a document's `path`, `workspace` and `date`, a
query's `answer` and `date`. One set runs both ways: a search run lays the documents out as notes and searches them; a
memory run (`memoryCases`) saves the dated documents as sessions, and a reader answers and a judge grades.
`node packages/bench/scripts/registry.mjs` writes `packages/bench/benchmarks.generated.json`, which the Lab, `tex_dev
evals` and the eval workflow read; fast guards fail when a folder is malformed or the list is stale. How to add one:
`packages/bench/README.md`.

**What a simplification would cost:** a gate on the made-up set alone tunes search to questions we wrote; a Test part
an agent can read is tuned against; letting a change's own harness read its ranks lets it grade itself. **Tests:**
`apps/mcp/bench/test/searchHard.test.mjs`, `benchRun.test.mjs` (the mean over sets, recall, an end-to-end set, the embedding file), `packages/bench/test/beir.test.mjs` (BEIR's files and nDCG, every folder's source, the folder list), `searchSuite.test.mjs`,
`scripts/search-test-set.mjs --self-test` (the paths, the gate, answers carry no words), `infra/tex-eval`'s search
tests (doors, caps, verdict), and `apps/convex/__tests__/controlPlane/labEvals.test.ts`.
