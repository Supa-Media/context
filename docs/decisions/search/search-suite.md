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

**What a simplification would cost:** a gate on the made-up set alone tunes search to questions we wrote; a Test part
an agent can read is tuned against; letting a change's own harness read its ranks lets it grade itself. **Tests:**
`apps/mcp/bench/test/searchHard.test.mjs`, `memoryRetrieval.test.mjs`, `searchSuite.test.mjs`,
`scripts/search-test-set.mjs --self-test` (the paths, the gate, answers carry no words), `infra/tex-eval`'s search
tests (doors, caps, verdict), and `apps/convex/__tests__/controlPlane/labEvals.test.ts`.
