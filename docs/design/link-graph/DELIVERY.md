# Link Graph and Unified Retrieval: performance, evaluation and delivery

Sections 16 to 20 and the appendices of the architecture, kept in their own file so each file stays under the repository's review threshold. Section numbers are unchanged; sections 1 to 12, 14 and 15 are in [README.md](./README.md), section 13 in [AGENT-LINKS.md](./AGENT-LINKS.md).

## 16. Performance and cost model

### 16.1 Reads and writes must be priced separately

Let `d` be the number of changed distinct references, `p` the reverse pages touched, and `h` the number of candidates actually inspected.

| Operation | Expected work to measure |
|---|---|
| Prose edit, reference set unchanged | Existing canonical write; one changed forward record when maintained; no reverse-set rewrite solely for an ETag bump. |
| Add/remove references | Forward record plus `p` reverse-page reads/writes and bounded repair bookkeeping; ordinarily proportional to changed memberships. |
| Fetch related notes | Source record/overlay, targeted permitted reverse/neighbor/URL lookups, candidate verification, and requested evidence reads. |
| Query-time text similarity | Existing selective text-index reads; no permanent pairwise similarity graph. |
| Move | Existing copy/retirement/policy work plus source reads and conditional edits of affected referrers; bounded by actual references, not constant time. |
| Full rebuild | At least a census and all eligible source bytes, plus derivative writes. It is not free merely because it is reproducible. |

“Usually a few objects” is an expectation for low-degree notes, not a complexity guarantee. Large hubs, URL lists, long files, and weak/slow providers need explicit caps and measurements. Paging a reverse list reduces write size; it can increase the number of reads needed for traversal.

The graph may improve system speed in two distinct ways: lower server-side retrieval cost for a relationship query, or fewer subsequent agent search/fetch calls to obtain the right evidence. Report those separately. Do not hide a slower search endpoint behind a claim that the agent *might* need fewer calls.

### 16.2 Measure both parties' costs

For a measured workload, compute:

```text
user_storage_cost = GET + PUT + LIST + stored_bytes + egress + provider_retries
platform_cost     = gateway_compute + scheduler/coordination + cache_resources
agent_cost        = added input/output tokens + follow-up calls + added writes
maintenance_cost  = reconcile + repairs + rebuilds amortized over real usage
```

Use provider prices and deployment limits captured with the benchmark run, not constants copied from a historical repository comment. Show steady-state, cold-start, burst-edit, and rebuild costs separately. A query that downloads a large graph once and then looks cheap in memory still incurred that initial download.

For the Fast Search retirement decision, compare these totals with the current D1 lifecycle and operational burden. No new per-query model bill is introduced by this design, but the user's agent can still spend tokens reviewing suggestions. Moving expense from Context to the user's bucket is not evidence that the feature became free.

### 16.3 The Worker subrequest ceiling

The gateway runs on Cloudflare Workers, and its search code is written against 50 subrequests per invocation (Cloudflare's free tier; `apps/mcp/src/search/maintain.js`, `search/visible.js`, `search/shards/constants.js`). Work handed to `waitUntil` after the response spends the same counter (`apps/mcp/test/workerCtx.mjs` explains why the tests model it that way). A single `write_note` already spends subrequests on the privacy manifest, the read before the write, the write, any collaboration state, activity and audit records, and search projection.

Therefore:

- Each write carries an explicit operation budget for everything after the commit, shared by suggestion retrieval and any inline graph work. When the remainder cannot afford a useful candidate pass, suggestions report `skipped`; the write is unaffected.
- Forward-record and reverse-page maintenance for a write is not done inline beyond what the remaining budget allows. The rest is recorded as pending work and completed by later, separately budgeted invocations (the shared maintenance pass), so a note with many changed references never risks the write's own invocation.
- Every benchmark in section 17 reports subrequests per operation alongside latency, against both the free-tier ceiling and any higher ceiling a deployment has, and a design that only fits the higher ceiling must say so.

## 17. Benchmark and evaluation plan

### 17.1 Baselines and ablations

Run comparable systems against the same corpus snapshots and permission views:

| ID | Variant | What it isolates |
|---|---|---|
| B0 | Current bucket-native BM25F, unchanged. | Current baseline, including known coverage limits. |
| B1 | Improved full-coverage/chunked lexical index, no graph. | Benefit of fixing lexical coverage and storage alone. |
| B2 | B1 + direct links/backlinks/shared linked targets. | Incremental graph value. |
| B3 | B2 + shared-URL signal. | Whether URL relatedness earns its cost. |
| B4 | B3 + directory signal. | Whether folder information adds more than noise. |
| B5 | Current opted-in D1 Fast Search. | Existing faster-search benchmark and retirement comparator. |
| A0 | Agent writes with ordinary search/read/write and basic link guidance. | Prompt-only authoring baseline. |
| A1 | Same agent and task budget, plus bounded post-write candidates. | Incremental value and cost of the proposed nudge. |

Add PageRank/PPR, embeddings, or learned ranking only as separately identified experiments after these baselines exist. Existing research such as A-MEM demonstrates agentic memory/linking approaches, but its generated memory representation and evaluation do not establish that Context should adopt that architecture or that a post-write MCP nudge is optimal. [E7]

### 17.2 Corpus matrix

Include small and medium personal workspaces, larger team workspaces, imported Markdown, sparse/unlinked notes, dense hubs, same-name files, long documents with answers beyond the old cap, bundled messages, drawings, supported non-English content, varied directory structures, and mixed/private/group access.

Test at least three increasing sizes rather than one favorable corpus. Proposed fixture points are roughly 100, 1,000, and 10,000 notes, plus stress cases beyond that range; these are evaluation samples, not a declared support limit. Vary bytes, edge degree, vocabulary, and message count independently of file count.

Use real provider measurements in addition to injected-latency fixtures. Cover cold/warm caches, different storage regions, concurrent writes, event loss, and high-degree targets. A “cold answer” counts only if it actually retrieved relevant content, not if it returned immediately with missing-index status.

### 17.3 Retrieval quality

Measure Recall@k and nDCG@k on judged queries, MRR for exact-destination tasks, and downstream agent task success/evidence accuracy under a controlled budget. Include exact names, deep-body terms, ambiguous concepts, prior decisions, dependencies, contradictions, and questions requiring more than one note.

Report query-class results, not only an aggregate. A graph that helps conceptual questions but breaks exact lookup must not hide behind its average. Measure visible evidence returned, duplicate results, unsupported/stale hits, and how often a useful note was lost to traversal limits.

The key comparison for graph value is **B2 versus B1**, not just B2 versus the currently capped B0. Otherwise fixing text coverage may be incorrectly credited to graph traversal.

### 17.4 Authored-link quality

Evaluate whether the link's surrounding sentence states a true, useful relationship; whether the target supplies the claimed evidence; whether the link improves later navigation or question answering; and whether it survives relevant edits/moves.

Measure harmful links, topic-only links, redundant repetitions, stale links, extra calls/writes/tokens, and the rate of successful tasks with zero links. Link count and suggestion acceptance are diagnostic measures, not objectives.

To test value beyond BM25, keep the same corpus and lexical engine, remove only the authored edges or replace them with cheap similarity neighbors, and compare held-out tasks. Separate structural usefulness from the usefulness of the author's explanatory prose. If cheap retrieval recreates the benefit with less cost and noise, keep that relationship derived rather than forcing it into Markdown.

### 17.5 Tuning discipline

Create an evaluation set before tuning. Use held-out workspaces and time periods; prevent benchmark questions, answer keys, or evaluation-generated links from leaking into candidate construction. Keep agent model/version, prompts, tool permissions, and budgets fixed within a comparison, repeat stochastic runs, and report uncertainty.

An evaluation agent may tune weights and traversal limits offline against this benchmark. That is not a new hosted-model dependency in production. Do not optimize for the same tasks used to claim improvement, or silently fine-tune on private customer content.

### 17.6 Safety and recovery measurements

Test output invariance when hidden notes, links, terms, URLs, and duplicate basenames are added or removed. Test tenant isolation, role/group changes, binding replacement, encrypted-note exclusion, and forged derivative records.

Measure convergence and lost-update behavior under interrupted writes, simultaneous updates to a popular URL, reversed event order, partial listings, corrupted pages, publication conflicts, rebuild cutover, and scheduler starvation. Track the time to a **correctly repaired** state, not merely the time to `pending = 0`.

### 17.7 Release and retirement gates

Graph features may release before Fast Search retirement, provided they preserve existing behavior and have honest fallbacks. Retirement requires all of the following:

| Gate | Evidence required |
|---|---|
| Ownership and privacy | No newly required external durable content store or model call; authorization/invariance tests pass; identified side-channel risks are reviewed. |
| Canonical safety | No data loss or unauthorized edit in fault-injection tests; partial/unknown move outcomes remain truthful. |
| Coverage | Long-note and message-bundle recall meets the supported target; known reductions remain explicit. |
| Quality | Held-out retrieval and agent-task results justify the graph compared with full-coverage lexical retrieval, not merely the old capped baseline. |
| Latency | Representative p50/p95/p99, cold and warm, meet a preregistered product objective and compare acceptably with D1. |
| Cost | Platform, customer storage, and agent overhead fit a measured operating budget without disguising a cost transfer. |
| Reliability | Index corruption, missed events, concurrent writers, and rebuilds converge without canonical repair guesses or false completeness. |
| Compatibility | Existing clients, console search, self-hosted deployments, and supported protocol versions remain usable. |

Absolute service objectives and economic thresholds are **not yet measured or approved**. Set and record them before tuning or deciding to retire D1. The 250 ms suggestion limit is an initial implementation experiment, not an invented overall latency SLA.

## 18. Required tests and implementation order

### 18.1 Tests are about properties and actual wiring

Use the repository's test-first and sabotage-testing practice. A passing helper test does not prove a tool returns its output, a UI can reach the feature, or two runtimes agree. [R1] [R11]

| Test family | Property to prove |
|---|---|
| Resolver parity | Editor, shared engine, gateway, and search extraction agree on supported targets and exclusions. |
| Patch preservation | Only intended target spans change; CRLF, Unicode, aliases, code, and unrelated bytes survive. |
| Structural changes | Duplicate/nested headings and small meaningful edits map correctly; link-only edits do not loop suggestions. |
| Forward/reverse consistency | Concurrent sources do not permanently lose memberships; interrupted cleanup is discoverable without a new note edit. |
| Catalog invalidation | New/deleted duplicate names update resolution of unchanged referrers. |
| Publication | Routing filters and bytes refer to the same published revision; stale writers cannot silently declare a mismatched index complete. |
| Mutation matrix | Every case in section 11 has an outcome test, including partial and unknown outcomes. |
| Privacy invariance | Hidden data cannot change visible graph answers, scores, counts, reasons, or candidate-selection outcomes. |
| Encrypted content | No plaintext terms/URLs/outgoing relations are written into the new derivative for an encrypted source. |
| Agent workflow | Existing write succeeds once; hints are optional, bounded, and accessible to the client; no planner/verifier/sampling call is made. |
| Cross-surface contract | Real serialized gateway results pass through the actual client/control-plane reader, not a fixture repeating one side's assumption. |
| Limits and degradation | Oversized records, hubs, slow providers, missing indexes, and timeouts do not become false “no results” or failed successful saves. |
| Recovery and migration | A killed maintenance/rebuild resumes; rollback reads stay coherent; cleanup affects graph derivatives only. |
| UI reachability | Related-note and repair affordances actually appear and navigate correctly on the supported layouts. |

Break each critical guard deliberately and confirm the relevant test fails. Report unit-fixture results, real-runtime tests, live-provider measurements, and device/browser checks as different kinds of evidence.

### 18.2 Implementation sequence

**Phase 0: Baseline and contracts.** Capture reproducible current search/cost measurements and link fixtures. Record the current parser disagreement. Specify field schemas, capability behavior, and initial release thresholds before claiming improvements.

**Phase 1: Shared link semantics.** Reuse/consolidate the supported link parser/resolver contract, preserve target-only rewrites, add full-body extraction and coverage states, and prove runtime parity. No graph-assisted ranking yet.

**Phase 2: Forward graph and maintenance.** Implement per-note facts, exact/bare/name/URL reverse postings, concurrency/repair handling, and shared census integration. Run integrity checks and rebuild tests before making the index a source of UI claims.

**Phase 3: Link integrity and exploration.** Use verified reverse lookups to accelerate existing reference maintenance; expose bounded related notes and actionable unresolved-link diagnostics. Preserve the existing scan fallback when coverage cannot be proved.

**Phase 4: Post-write candidates.** Extend ordinary `write_note` results with bounded optional evidence, within the per-write operation budget (section 16.3). Add deterministic changed-section detection, loop suppression, audience checks, and real client contract tests. No new model service or write protocol.

**Phase 5: Unified retrieval experiments.** Add graph/reference/directory evidence to the shared lexical pipeline. In parallel, evaluate full-note chunking and coherent selective-read publication. Run the full ablation and ROI matrix.

**Phase 6: Default-search replacement.** Only after the retirement gates pass, move all supported search surfaces to the successful bucket-native path, remove the Fast Search differentiation, and retire D1 through the existing safe release mechanism.

Each phase is a small tested change. The file describes the target and its constraints; it does not represent these phases as already implemented.

## 19. Migration, rollback, and decommissioning

A workspace with no graph continues to read, write, and search through the existing path. Build derivatives incrementally without requiring a rewrite of user content or a new frontmatter field.

Add graph format/layout definitions in the existing shared namespace owner. Unknown generations fail to an honest fallback. Preserve legacy dual-read rules for durable data; disposable search/graph formats may rebuild through their documented migration policy. Do not delete `.obsidian/`, assets, audit, forwarding, pending proposals, or unsent local work.

Benchmark the candidate path beside the existing one using synthetic or explicitly authorized data. Any temporary rollout flag is operational, not a user-facing Premium distinction. A privacy-sensitive shadow run may not silently create a new external copy of notes.

When retirement is justified, remove Fast Search settings/upsells coherently across per-workspace and blended search. Stop new D1 provisioning, route reads to the new path, and release existing projections through the lifecycle that retains database handles until deletion is confirmed. Do not remove a row first and strand a content copy nobody can subsequently identify. Existing consent, cancellation, export, and canonical retention behavior remain intact. [R5]

Rollback returns to a compatible working search path and a usable graph generation. It does not restore an incompatible index by pretending its schema matches, silently reactivate a previously opted-out external projection, or delete the user's new notes.

## 20. Explicit limits and remaining proof obligations

The product direction is sufficiently specified to implement without reopening every decision. The following remain engineering evidence gates, not hidden product decisions:

| Open proof/measurement | Required disposition |
|---|---|
| Exact structural parser implementation without a new runtime dependency | Select the smallest compatible implementation; keep current link semantics as the oracle. Adding a runtime dependency requires a deliberate repository-policy change, not a casual `remark` import. |
| Reverse-page size, partitioning, and collision policy | Benchmark with skewed hubs and concurrent writers; publish a bounded, validated format contract. |
| Privacy-safe mixed-visibility lookup under finite budgets | Prove output invariance; withhold an unsafe scoring optimization rather than weaken privacy. |
| Weak backend publication/repair behavior | Declare and test the actual guarantee; do not call read-compare atomic. |
| Full-note chunking and routing publication | Demonstrate coverage and bounded memory before replacing the capped index or retiring D1. |
| Trigger availability and convergence objectives | Measure per deployment; do not promise autonomous progress where no authorized worker runs. |
| Agent uptake and marginal link utility | Test real supported clients and held-out tasks. A suggestion cannot force a third-party agent to make a good edit. |
| Latency/cost retirement thresholds | Set before the retirement experiment, then report results rather than assuming the graph wins. |

Known limitations are intentional: external rename inference is not identity; path reuse can be ambiguous; links cannot retroactively retract prose already disclosed; a graph can be incomplete while notes are intact; unsupported Markdown is preserved rather than guessed; a hosted gateway is trusted compute rather than end-to-end secrecy; and the baseline has no mandatory semantic judge.

**Architectural summary:** commit canonical truth safely; derive reference facts in the user's bucket; reconcile rather than trust notifications; retrieve through one privacy-scoped engine; return a few optional candidates; let the user's agent author meaningful links in the Markdown; prove quality, speed, and cost before retiring the separate faster-search tier.

## Appendix A. Decision-to-implementation traceability

| Concern | Decision IDs | Main sections |
|---|---|---|
| Ownership, portability, one default search | D01–D03, D22 | 1–6, 16–19 |
| Link grammar, identity, moves, external changes | D04–D07, D20–D21 | 7, 10–11, 13.4 |
| Efficient forward/reverse storage | D08–D09, D14–D15 | 8–10 |
| Graph-assisted search and related notes | D10–D15, D23 | 12, 14, 17 |
| Agent link quality and simple MCP mechanics | D16–D20 | 13 |
| Caching, offline, privacy, failure handling | D01, D03, D10, D21 | 6, 9–12, 15, 18 |
| SOTA uncertainty, evaluation and ROI | D02, D22–D23 | 16–20 |

## Appendix B. Source map

Repository links below are pinned to the corrected baseline commit (R9 still names the commit that introduced partial-move rows). They establish the existing implementation/contracts, not proof that proposed features have shipped. Some decision files contain successive historical amendments; the applicable implementation and its tests must be checked rather than treating every historical paragraph as simultaneously current. External sources support specific protocol/storage/parser facts, not a claim that this architecture is universally optimal.

### Repository sources

- **R1. Product tenets and engineering constraints:** [CLAUDE.md](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/CLAUDE.md).
- **R2. Storage, credentials, migration and ownership:** [storage-and-credentials.md](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/docs/decisions/storage-and-credentials.md); [storageLayout.cjs](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/packages/shared/src/storageLayout.cjs).
- **R3. Existing link scanner, resolver and re-expression:** [apps/mcp/src/links.js](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/links.js).
- **R4. Bounded path forwarding, not stable identity:** [forwarding.js](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/forwarding.js).
- **R5. Search policy, visibility, D1 lifecycle and blended search:** [search.md](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/docs/decisions/search.md).
- **R6. Search formats, caps, maintenance, routing and fixture measurements:** [search/CONTRACT.md](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/search/CONTRACT.md).
- **R7. Separate current search link extraction:** [search/indexer.js](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/search/indexer.js).
- **R8. Editor links, parity, offline, communications rendering and collaboration:** [app-and-console.md](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/docs/decisions/app-and-console.md); [gateway-protocol.md](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/docs/decisions/gateway-protocol.md).
- **R9. Partial batch moves and audit outcomes:** [reviewed commit, “A batch move that partly applied leaves a row”](https://github.com/Supa-Media/context/commit/0057b63c46d07632a8c18c3da55c894f89f29051).
- **R10. Actual MCP tool schemas, the write path, and encryption exclusion:** [tools/schemas/](https://github.com/Supa-Media/context/tree/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/tools/schemas); [tools/notes/write.js](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/tools/notes/write.js); [search/maintain.js](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/search/maintain.js).
- **R11. Test-first and sabotage-testing requirements:** [CLAUDE.md, engineering standards](https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/CLAUDE.md).

### External primary sources checked on 2026-10-04

- **E1. Single-key atomicity is not multi-key atomicity:** [Amazon S3 data consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel).
- **E2. Conditional mutation semantics:** [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html); [conditional requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html). Implement against verified endpoint capabilities; API support varies.
- **E3. Bucket notifications are at-least-once:** [Amazon S3 Event Notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html).
- **E4. MCP tools and the client/model interaction boundary:** [MCP tools, protocol revision 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx). Context retains compatibility with the protocol revisions it actually implements; these example calls introduce no new transport requirement.
- **E5. Markdown syntax-tree structure and parser distinction:** [mdast specification](https://github.com/syntax-tree/mdast/blob/main/readme.md); [remark documentation](https://github.com/remarkjs/remark/blob/main/readme.md).
- **E6. URL parsing and serialization:** [WHATWG URL Standard](https://url.spec.whatwg.org/). Its parsing rules do not authorize aggressive semantic equivalence or remote canonicalization.
- **E7. Related research, not an adopted production dependency:** [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110), Xu et al. Its agentic organization/linking results motivate evaluation; they do not validate this specific Markdown/MCP workflow.
- **E8. Direct object consistency versus cached delivery:** [Cloudflare R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/).

<!-- Reference definitions for inline source citations. -->
[R1]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/CLAUDE.md
[R2]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/docs/decisions/storage-and-credentials.md
[R3]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/links.js
[R4]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/forwarding.js
[R5]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/docs/decisions/search.md
[R6]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/search/CONTRACT.md
[R7]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/search/indexer.js
[R8]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/docs/decisions/app-and-console.md
[R9]: https://github.com/Supa-Media/context/commit/0057b63c46d07632a8c18c3da55c894f89f29051
[R10]: https://github.com/Supa-Media/context/tree/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/apps/mcp/src/tools/schemas
[R11]: https://github.com/Supa-Media/context/blob/b5ad06c6937a4cf94724591f0af36ab008e9b1e9/CLAUDE.md
[E1]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel
[E2]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html
[E3]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html
[E4]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx
[E5]: https://github.com/syntax-tree/mdast/blob/main/readme.md
[E6]: https://url.spec.whatwg.org/
[E7]: https://arxiv.org/abs/2502.12110
[E8]: https://developers.cloudflare.com/r2/reference/consistency/
