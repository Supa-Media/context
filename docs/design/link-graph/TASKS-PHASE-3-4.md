# Link graph: Phase 3 and 4 tasks

Part of the task breakdown for [PLAN.md](./PLAN.md); global constraints and Phases 0 to 2 are in [TASKS.md](./TASKS.md). Split out so each file stays under the repository's review threshold.

## Phase 3 and 4 tasks

Drafted from PLAN.md Phases 3 and 4 and the architecture. Every point the sources left open (OPEN-23 to OPEN-45) is settled as a controller ruling the owner can reverse at review. OPEN-27 and OPEN-33 accept a one-bit freshness residual for team callers; they are flagged for the owner in the Phase 3 PR.

### Phase 3 and 4 global constraints

- **Indistinguishable absence** (arch 7.3). No surface (tool text, console panel, Convex result, error) may let a caller tell a forbidden note from a nonexistent one. Every path, count, reason, excerpt, hub decision and label is computed only from entries that passed the caller's `canSee` first (arch 12.4: truncation, common-neighbour selection and hub penalties run on permitted candidates, not on a global top-k filtered afterwards). Errors for a path the caller cannot see are byte-identical to `read_note`'s `not found` (`apps/mcp/src/tools/notes/read.js:128`).
- **Possibly incomplete is said, never hidden** (P4, arch 12.3, 14). Any graph-derived answer carries `possiblyIncomplete: true` when `graphHealth(...).possiblyIncomplete` is true (always on best-effort stores), when the graph is `unavailable`, or when a `readPostings` call returned `complete: false`. An unavailable graph still returns whatever the lexical and in-request parts found; it is never rendered as an empty workspace.
- **The graph is never the authority for a canonical edit** (O1, arch 11.1, 15.3). Moves use postings only to choose which bodies to read; the rewrite still re-reads and re-parses each body with `rewriteLinks`. A posting entry never grants a read: `canSee` runs before any body or node is fetched.
- **Optional work never changes a write** (O3, arch 13.5, 16.3). Suggestion code runs after the commit, inside try/catch, and its absence, failure or timeout leaves the existing `write_note` text byte-identical apart from the appended block.
- **No model calls, no planner** (arch 12.2, 13.6). Term selection, heading selection and lookups are deterministic code.
- New gateway test files are node:test style and are added to the `test` script in `apps/mcp/package.json`. Convex tests run with `pnpm --filter @context/convex test` (vitest); mobile tests with `pnpm --filter @context/mobile test` (jest).

### Phase 3 and 4 decision table

| Choice | Answer | Source |
|---|---|---|
| Relation shape | `{ path, reasons: ("links_here" \| "linked_from_here" \| "shares_target" \| "shares_url" \| "related_text" \| "nearby")[], evidence?: string }`, per caller, visible subgraph only | PLAN Phase 3 |
| `related_notes` contract | `related_notes({ path, limit? })`, read-only, `title` "Related notes" | PLAN Phase 3, P7 |
| Move index use | Postings only when coverage is proven complete; otherwise, and always on P4 storage, the existing scan | PLAN Phase 3, arch 11.1 |
| Flag that says "complete" | `graphHealth(store, budget).complete` (TASKS Task 9, OPEN-13) | TASKS Task 9 |
| Whether `complete` alone proves move coverage | OPEN-23 (Task 13) | arch 11.1 "not a completeness oracle" |
| Move-time validation of posting entries | OPEN-24 (Task 14) | arch 15.3 |
| Moves during an active logical move job | OPEN-25 (Task 14) | not addressed |
| Folder moves that rename attachments | Scan (attachments have no `incoming/`, OPEN-5) | TASKS Task 5 OPEN-5 |
| Graph writes from moves | None in Phase 3; reconciliation (OPEN-20 stands) | TASKS Task 8 OPEN-20 |
| Retrieval core location and shape | OPEN-26 (Task 15) | arch 12.1 names `retrieveCandidates(seed, intent, budget)`; PLAN lists only `tools/related.js` |
| Backlinks via bare names | Exact-path `incoming/` plus `bare/` entries whose written name uniquely resolves to the note in the caller's visible catalog | arch 7.4 |
| Hidden entries and the read budget | OPEN-27 (Task 15) | arch 12.4 "mixed-visibility physical pages" |
| Hub penalty and expansion constants | OPEN-28 (Task 15) | arch 8.4, 12.3: constants are experiment parameters |
| Evidence text per reason | OPEN-29 (Task 16) | PLAN `evidence?` optional |
| `nearby` as a reason | OPEN-30 (Task 16) | arch 8.3, 12.2 step 5 |
| Ordering of related notes | OPEN-31 (Task 16) | arch 12.3 rank fusion, constants are experiments |
| Encrypted seed note | OPEN-32 (Task 15) | arch 7.6 |
| Workspace-level freshness label shown to a team caller | OPEN-33 (Task 16) | arch 7.3, 12.4 |
| `related_notes` read budget and `limit` bounds | OPEN-34 (Task 17) | not addressed |
| Unresolved-link diagnostics surface | Console, on the note that has them; tool OPEN-35 | PLAN Phase 3, arch 14 |
| Console data path | A new Convex file operation through `runFileOperation`, importing the gateway core the way `lib/fileOps/search.ts` imports `search/visible.js` | PLAN "control-plane file operation"; existing pattern |
| `executeOperation.ts` is 975 lines | OPEN-36 (Task 18) | 1,000-line rule |
| Console reference repair (`apps/convex/functions/lib/fileOps/references.ts`) | Unchanged in Phase 3 (PLAN names only the gateway's `tools/moves/references.js`) | PLAN Phase 3 Files |
| Suggestion limits | 2 changed sections, 3 candidates, 2 hops, 250 ms, 4 KiB | P6, AGENT-LINKS 13.5 |
| Suggestion statuses | `ready`, `none`, `skipped`, `unavailable`, `partial`; no hidden counts in any status | AGENT-LINKS 13.5 |
| Budget for suggestions | The single per-write budget object Task 8 creates; suggestions spend first, graph work takes the rest | P5, TASKS Task 8 |
| Which callers get suggestions | Only `write_note`; `remember`, comments, forms and others never (O3). Mechanism OPEN-37 (Task 23) | O3, P6, PLAN Phase 4 |
| Pre-write body for the diff | OPEN-38 (Task 23) | AGENT-LINKS 13.4 |
| Encrypted note written | OPEN-39 (Task 23) | arch 7.6 silent on in-request suggestion seeds |
| Audience rule mapping | OPEN-40 (Task 22) | AGENT-LINKS 13.7 states the principle |
| Candidate `etag` field | OPEN-41 (Task 22) | AGENT-LINKS 13.3 example has it; PLAN Phase 4 list does not |
| Signal vocabulary | OPEN-42 (Task 22) | AGENT-LINKS 13.3 `text_match` vs PLAN Phase 3 `related_text` |
| `structuredContent` "where supported" | OPEN-43 (Task 23) | PLAN Phase 4; no tool returns it today |
| Text rendering of the block | OPEN-44 (Task 22) | AGENT-LINKS 13.8: XML optional |
| Where the guidance lives | OPEN-45 (Task 24) | AGENT-LINKS 13.2 lists instructions, `orient`, `write_note`; PLAN lists instructions and `write_note` |
| Duplicate-suggestion cache | Not built (AGENT-LINKS 13.7 says "may") | AGENT-LINKS 13.7 |
| Decision records | Appended to `docs/decisions/link-graph.md` (Task 12, OPEN-17) | PLAN "Across every phase" |

---

## Phase 3: link integrity and exploration

PR: "Phase 3: backlinks, related notes, and index-assisted link repair", based on the Phase 2 branch (P1). May split into "index-assisted link repair" (Tasks 13, 14) and "backlinks and related notes" (Tasks 15 to 19) if it grows too large to review (P1).

## Task 13: record what the last complete sweep covered

**Files:** `apps/mcp/src/graph/reconcile.js` (Task 10), `apps/mcp/src/graph/manifest.js` (Task 9), `apps/mcp/src/graph/records.js` (Task 4, manifest parser), tests extend `apps/mcp/test/graphReconcile.test.mjs` and `apps/mcp/test/graphManifest.test.mjs`.

**Why.** `graphHealth().complete` says a sweep wrapped on a complete census with nothing pending. It does not say anything about writes after that sweep: a per-write projection that ended `pending` or `stale` (Task 8 leaves them to reconciliation), an external edit, or a move (OPEN-20). Arch 11.1 forbids treating the index as a completeness oracle. Task 14 needs a time before which every note's references are known to be in the postings.

**Ruling (controller, OPEN-23):** how a move proves coverage. Recommend: `complete` plus a recent-change top-up. The sweep records the census's own listing time; at move time, every caller-visible note whose listing `uploaded` is at or after that time minus a margin (or is missing or zero) is read and rewritten as by the scan, in addition to the posting referrers. Cost if wrong: a referrer edited after the last sweep keeps a broken link while the move reports the rewrite as done, which is the exact failure arch 11.1 forbids; the cheaper alternative (use the index only when nothing changed since the sweep) is correct but almost never fires on an active workspace.

**Data model.** `manifest.health.sweepCensusAt: string | null`: the ISO listing time of the search census the last complete sweep used (the search manifest's freshness/listing time that `censusFromManifest` / `loadCensus` read; the implementer names the exact field and stops to ask if the census carries no listing time). Set only when a sweep wraps with `censusComplete` and sets `sweepComplete`; cleared (`null`) whenever `sweepComplete` is cleared. Old manifests without the field parse as `null`.

**API.** `graphHealth` gains `coveredThrough: string | null` (the stored `sweepCensusAt` when `complete` is true, else `null`). No counts (arch 7.3).

**Tests (write first).** A wrapped sweep on a complete census records the census listing time, not the wall clock; a wrap on a truncated census records nothing; a manifest without the field parses and reports `coveredThrough: null`; `coveredThrough` is `null` whenever `complete` is false (best-effort store, `state` not `ready`). Sabotage: record `now` instead of the census time and the census-time test fails.

## Task 14: index-assisted referrer lookup in `rewriteReferences`

**Files:** `apps/mcp/src/tools/moves/references.js` (175 lines; narrow the key set only), `apps/mcp/src/tools/moves/indexedReferrers.js` (new), tests `apps/mcp/test/moveIndexedReferrers.test.mjs` (new). Existing move tests (`links.test.mjs`, `auditReferenceRewrite.test.mjs`, `encryptionGateway/core.test.mjs`) must pass unchanged.

**Shape of the change.** `rewriteReferences` keeps everything it does today (listing via `listAllNoteKeys`, `canSee` filter, `LINK_SCAN_CAP`, `byName` over pre-move paths, the encrypted skip, collaboration writes, the `rewrite_references` audit row, the returned `{ notes, links, capped, failed }`). The only change: after `keys` is built and filtered, it may replace the list of keys it reads with a smaller candidate set from `indexedReferrerKeys`. Every caller (`move_note`, `move_notes`, `move_folder`, `archive_note`, `materialize_move`) gets the change through this one function.

**API.** `async indexedReferrerKeys(store, { visibleListing, renames, canSeeKey })` in `indexedReferrers.js`, returning `string[] | null` (`null` means "scan"):

1. `graphHealth(store, budget)`; return `null` unless `complete` is true and `coveredThrough` is set. Best-effort stores never pass (`complete` is false there, Task 9), which is P4's "always scan".
2. Return `null` when any key of `renames` is not a `.md` path (attachments have no `incoming/`, OPEN-5), or when a logical move job is active (OPEN-25).
3. Candidates = the moved notes' new keys (they always need their own relative links re-expressed, as the comment in `references.js` says) plus, for each `[from, to]` in `renames`: `readPostings` on `incoming/<pathHash(from)>` and on `bare/<nameHash(basename of from)>`, both with `canSee: canSeeKey` and the validation rule of OPEN-24. Posting sources that are themselves moved are mapped to their new key through `renames`.
4. Plus the top-up of Ruling (controller, OPEN-23): every entry of `visibleListing` whose `uploaded` is missing, zero, or at or after `coveredThrough` minus the margin.
5. Return `null` if any `readPostings` result has `complete: false`, if any op is refused by the budget, or on any thrown error. Otherwise the candidate set intersected with `visibleListing`'s keys.

Budget: one `createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET)` for the graph reads (`search/maintain.js:212`, `search/visible.js:81`). The body reads that follow stay as today (unbudgeted waves of `REFERENCE_READ_CONCURRENCY`).

- **Ruling (controller, OPEN-24):** move-time validation. Recommend `validate: () => true` (no node read per entry): a stale entry costs one wasted body read that `rewriteLinks` returns `null` for, while a dropped valid entry is a missed referrer; arch 15.3 makes the re-read body the authority. Cost if wrong: one extra GET per stale entry versus `validateEntry`'s one GET per entry.
- **Ruling (controller, OPEN-25):** active logical move jobs (`loadMoveJobs`, `apps/mcp/src/moves/jobs.js`). Recommend scan whenever any job is active, because postings are keyed by physical paths while the overlay presents logical ones. Cost if wrong: slower moves while a large folder move is materializing.
- **OPEN-23 margin.** Recommend 10 minutes, a named constant with a `lean:` comment (provider clock versus census clock skew). Cost if wrong: a few extra body reads (too large) or a missed referrer under skew (too small).

**Tests (write first).** On `memoryBucket()` with a complete graph built by `reconcileGraph`: for single move, batch move and folder move fixtures, the rewritten bodies, the audit row and the returned counts are identical with and without the index (run each once with a store whose graph manifest is removed to force the scan). Incomplete index (`state: "behind"`, or a truncated chain) falls back to scan and still rewrites everything. `memoryBucket({ ignoreIfMatch: true })` (best-effort) always scans: assert no node or posting read happens. A note edited after the sweep and not projected (its new link to the moved note absent from postings) is still rewritten via the top-up. A folder move that includes a `.png` scans. Privacy: a team caller's move with a hidden referrer present in the postings never reads that body (wrap `get`, assert the hidden key is never fetched) and returns counts identical to the scan's. Assert the index path reads fewer note bodies than the scan on a 200-note fixture with 3 referrers. Sabotage: skip the `uploaded` top-up and the edited-after-sweep test fails; accept `complete: false` chains and the truncated-chain test fails; drop the `.md` check and the attachment test fails.

**Parallel:** after Task 13. Disjoint from Tasks 15 to 19.

## Task 15: graph neighbourhood for one note (per caller)

**Files:** `apps/mcp/src/graph/neighbors.js` (new), tests `apps/mcp/test/graphNeighbors.test.mjs` (new).

**Ruling (controller, OPEN-26):** where the retrieval core lives. Recommend the core in `apps/mcp/src/graph/` (`neighbors.js` here, `retrieve.js` in Task 16) and only the MCP wrapper in `apps/mcp/src/tools/related.js` (Task 17), so the Convex operation (Task 18) and `suggestLinks` (Task 22) import the core without the tool layer, as Convex already imports `search/visible.js`. Cost if wrong: one module move.

**Data model.** Internal neighbourhood result: `{ incoming: Map<path, { exact: boolean, bare: boolean }>, outgoing: Map<path, { occurrences: number }>, sharedTargets: Map<path, number>, sharedUrls: Map<path, number>, unresolved: [{ target, start, end, state }], complete: boolean }`. `state` is one of `missing | ambiguous | unknown | invalid | unsupported` from `resolveReference` (Phase 1). Scores in the two `shared*` maps are already hub-penalized.

**API.** `async graphNeighbors(store, budget, { path, body, catalog, canSeeKey, limits })`:

- `catalog` is the caller-visible catalog: `{ byName: indexByName(visiblePaths), paths?: Set }` built by the caller from `loadDocmapPaths` filtered by `canSeeKey` (the same source `notePathIndex` in `apps/convex/functions/lib/fileOps/search.ts:185` uses). `paths` is passed only when the search index reports itself converged; otherwise resolution reports `unknown`, never `missing` (arch 7.3).
- **Outgoing** (`linked_from_here`) and **unresolved**: from `extractReferences(body)` resolved with `resolveReference(occ, path, catalog)`, in-request, so the seed's own links are never stale (arch 12.1). `external` occurrences with `http`/`https` targets go through `urlKey` for the URL step. No graph read is needed for this part.
- **Incoming** (`links_here`): `readPostings(incoming/<pathHash(path)>)` plus `readPostings(bare/<nameHash(basename)>)` keeping a bare source only when `catalog.byName` resolves that name uniquely to `path` (arch 7.4 late binding). Both with `canSee: canSeeKey` and `validate: validateEntry(store, budget, gen)` (O1: validated against the source's current forward record).
- **Shared target** (`shares_target`, two hops, P6): for each resolved outgoing target T (visible), `readPostings(incoming/<pathHash(T)>)`, sources other than `path`.
- **Shared URL** (`shares_url`): for each URL key, `readPostings(urls/<urlHash(key)>)`, sources other than `path`. A URL found only in a hidden note contributes nothing, because hidden sources are dropped before counting (arch 12.4).
- Generation pinned once per call from `loadGraphManifest`; when the graph is `unavailable` the graph parts are empty and `complete` is false.
- **Ruling (controller, OPEN-32):** encrypted seed (`isEncryptedNote(body)`). Recommend: no outgoing, unresolved, shared-target or shared-URL parts (nothing derived from its text, arch 7.6), incoming only. Cost if wrong: less related information for encrypted notes.
- **Ruling (controller, OPEN-27):** hidden entries and the budget. Pages mix visible and hidden entries, so how many ops a chain costs, and whether it finishes, depends on hidden data. Recommend: for a non-owner caller (`scope !== "private"`), a reason family any of whose chains returned `complete: false` is dropped entirely (not partially listed) and the result is labelled possibly incomplete; record the remaining one-bit timing/label channel in the decision record as arch 12.4's "withhold for the affected scope until invariance tests pass" residual. Cost if wrong: either a residual inference channel (too lax) or team callers losing graph reasons on large workspaces (too strict).
- **Ruling (controller, OPEN-28):** hub constants. Recommend: shared-target contribution `1 / log2(2 + d)` where `d` is T's visible degree (visible entries in its incoming list), and targets with `d > 50` are not expanded; shared-URL the same with its own visible degree; constants named in the module as experiment parameters (arch 12.3). Cost if wrong: ranking tuned again in Phase 5, no format change.

**Tests (write first).** Fixture on `memoryBucket()` with a projected graph: backlinks from an exact link and from a unique bare name; a bare name that is ambiguous in the caller's view is not a backlink; a bare name ambiguous only because of a private duplicate is a backlink for a team caller (arch 7.4); `../` escape reported `invalid` in `unresolved`; a missing target is `missing` with `catalog.paths` and `unknown` without. Privacy invariance: for a team caller, adding or removing a hidden note, a hidden link to the seed, a hidden note citing the seed's target, and a hidden note citing the seed's URL leaves the returned structure deep-equal. Hub: a target cited by 60 visible notes is not expanded. Encrypted seed returns incoming only. Sabotage: count degree before `canSee` and the hidden-citer invariance test fails; skip the uniqueness check on bare backlinks and the ambiguous-name test fails.

**Parallel:** with Task 13 and Task 14 (disjoint files, no edge).

## Task 16: `retrieveCandidates` (lexical, nearby, merge, labels)

**Files:** `apps/mcp/src/graph/retrieve.js` (new), tests `apps/mcp/test/graphRetrieve.test.mjs` (new).

**API.** `async retrieveCandidates(store, { seed, intent, canSeeKey, isIndexable, budget, limits })`, the arch 12.1 function. `intent` is `"related_notes" | "link_suggestions"`; `seed` is `{ path, body, sections? }` (`sections` from Task 21 when the intent is `link_suggestions`). Returns `{ relations: Relation[], unresolved, possiblyIncomplete: boolean }` where `Relation` is the PLAN shape.

- Catalog: `loadDocmapPaths` filtered by `canSeeKey`, built once and passed to `graphNeighbors` (Task 15).
- **related_text:** deterministic term selection from the seed (title, then headings, then body terms; for `link_suggestions` only the given sections and their heading context), capped at a constant number of terms, passed as one loose query to `searchIndexedNotes(store, { isVisible: canSeeKey, isIndexable, query, budget, limit })` (`search/visible.js:278`). Hits other than the seed become `related_text`.
- **Ruling (controller, OPEN-29):** evidence. Recommend `evidence` only for `related_text`, taken from the hit's `snippets` (no extra read), and none for graph reasons in Phase 3. Cost if wrong: a reader opens the note to see the sentence around a backlink.
- **Ruling (controller, OPEN-30):** `nearby`. Recommend: added as a reason to an already selected candidate whose directory distance (arch 8.3 formula) to the seed is at most 2; never a candidate on its own in Phase 3. Cost if wrong: sparse workspaces show fewer related notes.
- **Ruling (controller, OPEN-31):** ordering. Recommend reciprocal rank fusion (k = 60) over the independently ranked lists (explicit links, shared targets, shared URLs, related text), with `nearby` as a tie-break only; explicit links are never dropped for text hits; constants named as experiment parameters (arch 12.3). Cost if wrong: retuned in Phase 5.
- Merge by path, keep every reason, exclude the seed, apply `limit` after authorization (arch 12.2 step 6).
- **Ruling (controller, OPEN-33):** `possiblyIncomplete` is `graphHealth.possiblyIncomplete || any neighbour part incomplete || search answer indexIncomplete`. Workspace-level health can flip because of a hidden note's edit. Recommend accepting that (it reveals no path, count, content or ranking) and stating it in the decision record; invariance tests hold health constant. Cost if wrong: a team caller can infer that something somewhere changed recently.
- Never throws; a graph or search failure removes that part and sets `possiblyIncomplete`.

**Tests (write first).** Unlinked notes still come back through `related_text`; an unavailable graph returns lexical results with `possiblyIncomplete: true`, never an empty answer when text matches (arch 12.3); a best-effort store always labels; hub notes do not bury an exact text hit; `limit` applied after `canSee` (a hidden strong match does not reduce the visible count returned); privacy invariance as in Task 15 for the merged list; `budget.spent` never exceeds the budget given. Sabotage: apply `limit` before `canSee` and the hidden-strong-match test fails; drop the label on best-effort mode and the P4 test fails.

**Parallel:** after Task 15.

## Task 17: the `related_notes` gateway tool

**Files:** `apps/mcp/src/tools/related.js` (new), `apps/mcp/src/tools/schemas/moves.js` (156 lines; definition right after `search_notes`), `apps/mcp/src/tools/dispatch.js` (212 lines; one `case "related_notes":` string literal, which `toolArguments.test.mjs` reads as the dispatch census), `apps/mcp/test/protocolBasics.test.mjs` (490 lines; tool counts 45 to 46 at lines 141, 303, 308 and forms-off 41 to 42 at line 257), `apps/mcp/test/protocolVersioning.test.mjs` (409 lines; counts at lines 51, 277), tests `apps/mcp/test/relatedNotesTool.test.mjs` (new). Follow how `remember` was added (commit `78fa7a53`).

**Definition.** `name: "related_notes"`, `title: "Related notes"`, `inputSchema` `{ path: string (required), limit?: integer }`, `additionalProperties: false`, `annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }`. Read-only, so `toolsForSession` offers it to read-only sessions; it is not added to `PRIVATE_TIER_ONLY_TOOLS` or `EXISTENCE_MASKED_TOOLS` (`apps/mcp/src/tools/registry.js`). The `context` argument is added centrally by `toolDefinitions`. `search` and `fetch` schemas are untouched (arch 14).

**Handler.** `toolRelatedNotes(store, scope, rules, overrides, args)`: normalize the path; if `canSee` fails or the note is absent, return exactly `toolError("not found")` (same text as `read_note`, arch 7.3). Read the body the way `toolReadNote` does (including the move overlay via `getVisibleMovedNote`), call `retrieveCandidates` with `intent: "related_notes"`, `canSeeKey = (k) => canSee(k, scope, rules, overrides, <granted groups as read_note passes them>)`. Text output: one line per relation `path (reasons)`, plus evidence when present, and a final `may be incomplete` line when `possiblyIncomplete`. No counts over the workspace.

- **Ruling (controller, OPEN-34):** budget and limit. Recommend `createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET)`, `limit` default 10 (`SEARCH_RESULT_LIMIT`), clamped to 1..25. Cost if wrong: one constant.
- **Ruling (controller, OPEN-35):** unresolved links in the tool output. Recommend not in the tool (PLAN puts them in the console; arch 14 says diagnostics live where a person can act). Cost if wrong: an agent cannot see a note's broken links without reading it.

**Tests (write first).** Through the real JSON-RPC handler (as `protocolBasics.test.mjs` does): listed for a read-only session; listed count 46 (42 with forms off); a team caller asking about a private note and about a nonexistent path gets byte-identical results; a team caller's answer is identical with and without hidden linking notes; output includes reasons and the incomplete line on a best-effort store; unknown argument refused by the schema. Sabotage: return a distinct message for a forbidden path and the indistinguishability test fails.

**Parallel:** after Task 16. Parallel with Task 18 (disjoint files; both only consume `retrieveCandidates`).

## Task 18: console data path for related notes

**Files:** `apps/convex/functions/lib/filesFns/operationValidators.ts` (524 lines; operation `{ kind: "related", path }` and its result validator), `apps/convex/functions/lib/filesFns/operationTypes.ts` (366 lines; types), `apps/convex/functions/lib/filesFns/executeOperation.ts` (975 lines; one delegating case), `apps/convex/functions/lib/fileOps/related.ts` (new; the operation body), `apps/convex/functions/lib/filesFns/related.ts` (new; `relatedNotesHandler`, shaped like `searchContextHandler` in `lib/filesFns/search.ts:53`), `apps/convex/functions/files.ts` (813 lines; `export const relatedNotes = action(...)`), tests `apps/convex/__tests__/relatedNotes.test.ts` (new).

**API.** `relatedNotes({ workspaceId, path })` action: `authorizeFileAccess` with `minimum: "member"`, then `runFileOperation` with `operation: { kind: "related", path }`. The operation body loads the privacy state, builds `isVisible` with this runtime's own `canSee(path, clearance.scope, rules, overrides, clearance.names)` (as `notePathIndex` does), reads the note through the existing read path, and calls the gateway's `retrieveCandidates` (imported by relative path, like `search/visible.js` is today). Result: `{ kind: "related", relations: [{ path, reasons, evidence? }], unresolved: [{ target, start, end, state }], possiblyIncomplete: boolean }`, or the same not-found result the `read` operation gives for an invisible or absent path.

- **Ruling (controller, OPEN-36):** `executeOperation.ts` is 975 lines. Recommend the new case is at most 5 lines and delegates to `lib/fileOps/related.ts`; if it would cross 1,000, stop and ask the controller rather than split the file inside this task. Cost if wrong: a refactor task inserted before this one.

**Tests (write first).** Vitest against the operation with the fake store the existing `fileOps` tests use: a member gets relations filtered by clearance; a member asking for a note outside their clearance gets the same result as for a missing path; `unresolved` carries `missing` only when the catalog is complete; `possiblyIncomplete` true on a best-effort store. Cross-surface (DELIVERY 18.1): one test feeds the real serialized operation result through the console's reader type (Task 19's `RelatedAnswer` parser) rather than a hand-written fixture. Sabotage: drop the clearance filter and the clearance test fails.

**Parallel:** after Task 16. Parallel with Task 17 and Task 14.

## Task 19: the "Linked here / Related" panel in the note view

**Files:** `apps/mobile/features/console/panes/browsePane/RelatedPanel.tsx` (new), `apps/mobile/features/console/panes/browsePane/useRelatedNotes.ts` (new), `apps/mobile/features/console/panes/browsePane/BrowseDocument.tsx` (501 lines; render the panel under the note for a `file` selection), `apps/mobile/features/console/files/browser/contract.ts` (883 lines; one optional `relatedNotes?` method), `apps/mobile/features/console/files/fileBrowser/useFileActions.ts` (77 lines; `useAction(api.functions.files.relatedNotes)`), tests `apps/mobile/__tests__/relatedPanel.test.ts` (new).

**Behaviour** (P7, arch 14). Two groups: "Linked here" (`links_here`) and "Related" (every other reason), each row showing the note title or path and its reasons in words ("links here", "linked from here", "cites the same note", "cites the same URL", "related text", "nearby"); rows navigate with the existing note-open action. Unresolved links of the open note listed with their state (missing, ambiguous, not supported, not yet checked) so the person can act on that note; no workspace-wide problem count (arch 14). Loading, unavailable (offline or error) and "may be incomplete" are distinct states; nothing is rendered as a confident empty list while loading or when `possiblyIncomplete` (arch 14 "a blank/loading/partial graph is not rendered as a confidently empty workspace"). Hidden on the demo console, whose browser has no `relatedNotes` (the optional method). Offline: no local graph is computed (arch 15.2 makes it optional); the panel says it needs a connection.

**Tests (write first).** Jest: the answer parser rejects a malformed result; the panel renders reasons as words; the incomplete state shows its notice; loading never shows "no related notes"; a row tap calls the open action with the path; unresolved rows show their states. UI reachability (DELIVERY 18.1): the panel appears under a note on both phone and pointer layouts (render `BrowseDocument` with a fake browser). Sabotage: render the empty message while loading and the loading test fails.

**Parallel:** after Task 18.

## Task 20: record Phase 3 and close the PR

**Files:** `docs/decisions/link-graph.md` (from Task 12), `docs/decisions/README.md` (561 lines; only if the index entry needs a new line).

Content: index-assisted move repair (coverage rule of OPEN-23, scan fallback, P4 always scan, attachments and active move jobs scan); `related_notes` as a read-only convenience tool (arch 14); the privacy residuals ruled in OPEN-27 and OPEN-33, stated plainly. "What reversing costs" and "the test that fails" name the real test files and check names from Tasks 14, 15 and 17. PR text states what was verified (unit, runtime, live) and what was not; device/browser checks of the panel reported separately (DELIVERY 18.1).

**Tests.** None new; the named tests must exist and pass. **Parallel:** last in Phase 3.

---

### Phase 4: post-write candidates

PR: "Phase 4: optional link suggestions after a write", based on the Phase 3 branch (P1).

## Task 21: `detectChangedSections`

**Files:** `apps/mcp/src/graph/changes.js` (new), tests `apps/mcp/test/graphChanges.test.mjs` (new).

**Data model.** Section: `{ heading: string | null, depth: number, start: number, end: number, text: string }`; offsets are JavaScript string offsets into `committed` (AGENT-LINKS 13.4); `heading` is `null` for text before the first heading.

**API.** `detectChangedSections(before, committed, { maxSections = 2, maxInputChars })` returns `{ sections: Section[], status: "changed" | "skipped" | "new" }`. Pure, synchronous, bounded input (a constant cap on characters diffed; beyond it the note is treated as new and only its first eligible sections are taken, AGENT-LINKS 13.4 "report a limited pass").

- Heading intervals in document order; each ends at the next heading of equal or shallower depth (AGENT-LINKS 13.4). Duplicate headings are distinguished by position, never by text.
- A line diff of `before` and `committed` mapped to intervals. `before === null` (no reliable old body) or `""` (create) is status `new` with sections chosen in document order.
- Excluded from suggestion seeds (AGENT-LINKS 13.4): frontmatter, fenced and inline code (`codeRanges`), changes that only add, remove or retarget link syntax (compare the texts with link markup reduced to its visible text, using `extractReferences` spans), and whitespace or emphasis-only changes. A negation or number change is not trivial, so no size threshold.
- At most `maxSections`, preferring sections with the most changed prose.

**Tests (write first).** Duplicate headings (`## Notes` twice, edit the second); nested headings (edit under `###` maps to the `###` interval, not its parent's whole range); text before the first heading; a new heading; a deleted heading; a pure link-wrap edit (the AGENT-LINKS 13.3 step 6 example) is `skipped`; a one-word negation edit is `changed`; a table and a nested list edit; an edit inside a code fence is not a section; a merged collaborative text where another person's edit landed in a different section (only the diffed sections against `before` count); a 1 MB body stays within the input cap. Sabotage: end intervals at the next heading of any depth and the nested-heading test fails; drop the link-only check and the link-wrap test fails.

**Parallel:** at Phase 4 start, with Task 24. No dependency on Phase 3 code.

## Task 22: `suggestLinks`

**Files:** `apps/mcp/src/graph/suggest.js` (new), tests `apps/mcp/test/graphSuggest.test.mjs` (new).

**Data model.** The block (AGENT-LINKS 13.3, PLAN Phase 4): `{ status, basedOnEtag, candidates: [{ path, section, signals, excerpt }] }`, at most 3 candidates, total rendered size at most 4 KiB in UTF-8 including guidance (P6; reuse `exceedsUtf8Bytes`).

**API.** `async suggestLinks(store, scope, { path, committed, etag, sections, audience, canSeeKey, isIndexable }, budget, { deadline })` returns the block. Calls `retrieveCandidates` (Task 16) with `intent: "link_suggestions"` and `seed: { path, body: committed, sections }`, using an in-request overlay of the committed text's facts (arch 12.1; no durable record of the new note is needed). Then: drop the source itself and every target the committed text already links to (AGENT-LINKS 13.7); apply the audience rule; dedupe across sections; keep 3; excerpt from search snippets, trimmed so the whole block fits 4 KiB; `section` is the heading of the section the candidate came from. Checks `deadline` (a `now()` comparison) between every step and before every op, so no new work starts after 250 ms (AGENT-LINKS 13.5: `Promise.race` alone does not stop work). Statuses: `ready`, `none` (searched, nothing worth returning), `skipped` (ineligible or budget/deadline before a useful pass), `partial` (deadline or budget hit after some candidates), `unavailable` (an exception).

- **Ruling (controller, OPEN-40):** audience rule. Recommend: the source's effective visibility (`effectiveVisibility`, `apps/mcp/src/privacy/engine.js:172`) decides; private source: any caller-visible candidate; `team` source: only candidates `canSee(c, "team", rules, overrides, [])` (visible to every team reader); a group-scoped source: only candidates visible to a reader holding just that group; anything not provably as broad is withheld (AGENT-LINKS 13.7). Cost if wrong: either a private title suggested for a team note (too lax) or useful team candidates withheld (too strict).
- **Ruling (controller, OPEN-41):** candidate `etag`. Recommend omitted (PLAN's field list; it costs one op per candidate and the agent's `read_note` returns it). Cost if wrong: an additive field later.
- **Ruling (controller, OPEN-42):** signals. Recommend the AGENT-LINKS 13.3 vocabulary for this block: `related_text` is rendered as `text_match`; `links_here`, `shares_target`, `shares_url` pass through; `linked_from_here` never appears (already linked targets are excluded); `nearby` alone never makes a candidate. Cost if wrong: a rename in the block, no stored data.
- **Ruling (controller, OPEN-44):** text rendering. Recommend plain lines (a one-line guidance sentence with the 13.2 substance, then `path (section; signals): "excerpt"` per candidate), every candidate-controlled string escaped of control characters and newlines; no XML (AGENT-LINKS 13.8 says optional). Cost if wrong: presentation change only.

**Tests (write first).** Audience: a team source never gets a private candidate even when the owner wrote it; a private source does. Source and already-linked targets excluded. Block under 4 KiB with three long excerpts (assert UTF-8 bytes, with multibyte text). Deadline: a fake clock past 250 ms after the first op starts no further op (assert op count) and returns `partial` or `skipped`. Budget: `budget.spent` never exceeds the budget; a budget of 0 is `skipped` with zero ops. A thrown search error is `unavailable`. No candidate count from hidden notes appears in any status. Sabotage: skip the audience filter and the team-source test fails; check the deadline only after I/O and the CPU-deadline test fails.

**Parallel:** after Tasks 16 and 21.

## Task 23: wire suggestions into `write_note`

**Files:** `apps/mcp/src/tools/notes/write.js` (481 lines plus Task 8's call), `apps/mcp/src/tools/dispatch.js` (212 lines; only if OPEN-37 is ruled opt-in), `apps/mcp/src/tools/notes/remember.js` (205 lines; only if OPEN-37 is ruled opt-out), tests `apps/mcp/test/writeSuggestions.test.mjs` (new), plus one check in `apps/mcp/test/remember.test.mjs` (381 lines).

**Order inside `toolWriteNote`** (AGENT-LINKS 13.6, P5): commit, `recordChange`, `projectWrittenNoteAfterResponse`, presence, forms, share and status lines exactly as today; then, when suggestions are enabled for this call, `detectChangedSections(before, committedPlaintext)` and `suggestLinks(...)` spending the per-write budget object from Task 8 first, with a 250 ms deadline; then Task 8's graph hook with whatever budget remains. Everything suggestion-related is in one try/catch that turns any throw into `status: "unavailable"`. `basedOnEtag` is `put.etag`.

- `committedPlaintext` is `collaborationResult.text` when merged, else `content` (never the sealed envelope).
- **Ruling (controller, OPEN-37):** how only `write_note` gets suggestions. PLAN's answer: `remember` passes an option that disables it. But `toolWriteNote` is also called by comments (`tools/notes/comment.js:172`, which is a `write_note` call with `comment`), forms (`tools/forms/tools.js:100`) and remember twice. Recommend opt-in instead: `options.linkSuggestions === true` passed only by the plain `write_note` branch of `dispatch.js` (line 92), so every other caller is off without each needing to remember the flag. Cost if wrong: one option name; an opt-out design risks a future caller returning suggestions against O3.
- **Ruling (controller, OPEN-38):** the pre-write body. Recommend: collaborative note: `base.text` from the `readCollaborationDocument` call already made in `write.js` (hoisted out of its `try`), which is the current merged document before this write, so the diff isolates this write's merged contribution; ordinary note: `storedBody` when not encrypted; create: `""`. AGENT-LINKS 13.4 names "the revision the caller read"; that revision is not retrievable today without an extra read. Cost if wrong: on a stale-base collaborative write, sections changed by others in between are not attributed to this write (fewer suggestions, never wrong ones).
- **Ruling (controller, OPEN-39):** encrypted notes. Recommend `status: "skipped"` without running retrieval (no decrypted text used as a query, consistent with arch 7.6's exclusion of encrypted text from search). Cost if wrong: encrypted notes get no suggestions.
- **Ruling (controller, OPEN-43):** `structuredContent` "where supported". The gateway passes no negotiated protocol version to tool handlers (`apps/mcp/src/mcp/handlers.js:169`, `:236`) and no tool returns `structuredContent` today. Recommend: keep the existing text block and append the rendered suggestion lines to it; add `structuredContent: { saved: { path, etag }, linkSuggestions }` on the result only for revisions from `2025-06-18` on, by threading the negotiated revision from `handlers.js` through `callToolForSession` as a store field (as `searchSubrequestBudget` is set on the store); older revisions get text only. Cost if wrong: if threading the revision is judged too wide for this task, a follow-up task adds `structuredContent` and Phase 4 ships text only.

**Tests (write first).** Through the real `toolWriteNote`: with suggestions skipped (budget 0), failing (search store throws) or timed out (fake clock), the write result text equals today's text byte for byte apart from at most the appended block, and the note, audit row and search projection are unchanged; `remember` never returns a block (both its create and update paths); a comment and a form write never return one; a link-only follow-up write (AGENT-LINKS 13.3 step 6) returns `skipped` and its graph facts still update (Task 8 hook still runs); a team note's write never suggests a private candidate; total ops after commit (suggestions plus graph) never exceed `WRITE_ENRICH_SUBREQUEST_BUDGET` (assert on a counting store); a collaborative merged write diffs the merged text. Protocol: a `tools/call` of `write_note` over the real JSON-RPC handler returns the text block first and, on `2025-06-18` or later, `structuredContent.linkSuggestions` (per OPEN-43). Sabotage: let the suggestion try/catch rethrow and the failing-search test fails; pass the option from `remember` (or drop the dispatch-only flag) and the remember test fails.

**Parallel:** after Tasks 21 and 22. Not parallel with Task 24 if OPEN-43 touches `mcp/handlers.js` only; they share no file otherwise.

## Task 24: the linking guidance

**Files:** `apps/mcp/src/mcp/instructions.js` (223 lines), `apps/mcp/src/tools/schemas/notes.js` (292 lines; the `write_note` description), tests `apps/mcp/test/linkGuidance.test.mjs` (new; kept out of `protocolBasics.test.mjs` so Task 17 and this task share no test file).

Content: the AGENT-LINKS 13.2 substance (preserve useful references; link a source where the relationship is stated; post-write candidates are optional leads, not verified relationships; read enough to confirm; skip topic-only matches; do not rewrite a note just to add links), concise, in the instructions and in the `write_note` description. The detailed guidance travels only with returned candidates (Task 22's guidance line). No new argument, no planner or token (AGENT-LINKS 13.2).

- **Ruling (controller, OPEN-45):** `orient`. AGENT-LINKS 13.2 also names `orient`; PLAN's file list omits it. Recommend PLAN's set (instructions plus `write_note` description; the description is the field every client delivers). Cost if wrong: a client that reads `orient` but neither instructions nor the description misses the guidance; adding it is a few lines in `apps/mcp/src/orient/`.

**Tests (write first).** `initialize` instructions contain the guidance sentence; the listed `write_note` description contains it; the existing instruction checks (`protocolBasics.test.mjs:34`, `:77`) still pass. Sabotage: remove the sentence from the description and the description test fails.

**Parallel:** at Phase 4 start, with Task 21 and Task 22.

## Task 25: record Phase 4 and close the PR

**Files:** `docs/decisions/link-graph.md`.

Content: O3 as built (suggestions on `write_note` only, the OPEN-37 mechanism, budget shared with graph work and spent first, 250 ms deadline, 4 KiB, statuses), the audience rule as ruled in OPEN-40, and the measured subrequests per write against the free-tier and hosted ceilings (DELIVERY 16.3 requires both; mark "not measured" if no live run was scheduled). PR text separates unit, runtime, live and real-client evidence (DELIVERY 18.1 "Agent workflow", "Cross-surface contract"); adoption across real clients (AGENT-LINKS 13.2) is listed as not measured unless the controller schedules it.

**Tests.** None new. **Parallel:** last in Phase 4.

---
