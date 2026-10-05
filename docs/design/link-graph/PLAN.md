# Link graph and unified retrieval: implementation plan

Status: plan for owner approval (2026-10-04). Companion to `README.md` in this
folder, which holds the architecture, the review corrections and decisions
O1 to O3. Nothing here is built yet.

## Decisions this plan rests on

| # | Decision (owner, 2026-10-04) |
|---|---|
| P1 | All six phases, one stacked PR per phase. Each PR is based on the previous phase's branch, has its own green CI, and merges only on the owner's explicit approval, bottom up. A phase that grows too large to review splits into two PRs. |
| P2 | Phase 6 (retiring Premium Fast Search) is built but not merged until the owner decides at the gate (O2). |
| P3 | Retirement gates: retrieval quality at least equal to Fast Search (Recall@10, nDCG@10), p95 latency no worse than 1.5 times Fast Search cold and warm, no increase in platform cost. Baselines are measured in Phase 0 before any tuning. |
| P4 | Storage without reliable conditional writes (B2, Wasabi): graph updated best effort on every write; moves there never rely on the reverse index (always the existing scan); graph answers there are labelled possibly incomplete. |
| P5 | Post-commit budget per write: `WRITE_ENRICH_SUBREQUEST_BUDGET`, default 8 storage requests, 80 on the hosted deployment, clamped like `SEARCH_SUBREQUEST_BUDGET`. Covers suggestions and inline graph work; whatever does not fit is skipped (suggestions) or left to maintenance (graph). Never limits the write itself. |
| P6 | Suggestion limits are the architecture's initial values: 2 changed sections, 3 candidates, 2 link hops, 250 ms, 4 KiB. Every `write_note` may return them (O3); `remember` and other tools never do. |
| P7 | Surfaces: a "Linked here / Related" panel in the note view, and a `related_notes` gateway tool. |
| P8 | Search coverage: per-note cap raised from 2,048 to 64,000 characters, indexed as chunks of about 2,000 characters (split at headings, then paragraphs, then sentences; hard maximum 3,000), reusing the per-message sub-document mechanism in `search/commsIndex.js`. Chunk size is a constant benchmarked at 1,000, 2,000 and 4,000 in Phase 5. |
| P9 | Tokenizer v2: NFKC normalization and lowercase, word segmentation with the runtime's `Intl.Segmenter` (verified in `workerd`), accent folding, identifier splitting (camelCase, snake_case, dotted) indexed both whole and split, CJK two-character pieces as a recall fallback, and a Porter2 (Snowball English) stemmer implemented in-repo, replacing today's hand-written rules for Latin-script words and verified against Snowball's published word list; other scripts stay unstemmed, and per-language stemming is revisited after Phase 0 measures note languages. Built and benchmarked in Phase 5, switched on only if it wins. |
| P10 | No new gateway runtime dependency (`CLAUDE.md`; enforced by `scripts/check-gateway-imports.mjs`). |

## Phase 0: baseline and contracts

**Goal.** Reproducible measurements of today's bucket search and Fast Search, and the format contracts later phases build on. No product behavior changes.

- **Data model.** Benchmark fixture sets under `apps/mcp/bench/fixtures/` (synthetic only): 100, 1,000 and 10,000 notes; long notes past 2,048 and 64,000 characters; bundled messages; duplicate basenames; dense hubs; Chinese, Japanese and code-heavy notes; mixed private/team visibility. Judged query sets (JSON: query, relevant paths, query class).
- **API.** A bench runner script (`pnpm bench:search`) that runs B0 (current bucket search) and B5 (Fast Search projection against a local D1) over the fixtures with injected store latency, reporting Recall@10, nDCG@10, MRR, p50/p95/p99 cold and warm, and subrequests per query. A language census over fixtures and, on request, an owner's own workspace (counts by script; nothing leaves the machine).
- **Files.** `apps/mcp/bench/` (new), `docs/design/link-graph/BASELINE.md` (results and the recorded P3 thresholds), a staging check that `Intl.Segmenter` segments Chinese in the deployed Worker.
- **Tests.** The runner's metric functions (recall, nDCG, MRR) against hand-computed cases; fixture generator determinism.
- **PR.** "Phase 0: search baseline and benchmark harness".

## Phase 1: shared link semantics

**Goal.** One link reader everywhere, full-note extraction, and resolution states; no new storage.

- **Data model.** A link occurrence: `{ kind: "wiki" | "inline", embed, target, start, end, fragment, style: "relative" | "rooted" | "bare" }` (extends today's `parseLinks` result). A resolution: `{ state: "resolved" | "missing" | "ambiguous" | "unknown" | "invalid" | "unsupported" | "external", path? }` (architecture section 7.3; internal only).
- **API.** `apps/mcp/src/links.js`: `extractReferences(text, fromPath)` (full body, code masked, occurrences with spans), `resolveReference(occurrence, fromPath, catalog)` returning a resolution. `search/indexer.js` drops its own `WIKILINK_RE`/`MDLINK_RE` and calls `extractReferences`. `packages/shared/src/links.ts` gains the same functions; `apps/convex/__tests__/linkParity.test.ts` extended to cover them.
- **Files.** `apps/mcp/src/links.js`, `apps/mcp/src/search/indexer.js`, `packages/shared/src/links.ts`, parity tests.
- **Tests.** Parity across gateway, app copy and search extraction on a shared fixture table; full-body extraction past 2,048 characters; code spans and fences ignored; reference definitions preserved and reported `unsupported`; bare names resolved only when unique in the caller's catalog; root escape `invalid`; existing move/rewrite tests unchanged. Sabotage: revert the indexer to its old regex and the parity test fails.
- **PR.** "Phase 1: one link reader across gateway, app and search".

## Phase 2: forward graph and maintenance

**Goal.** Per-note facts and reverse postings under `.context/graph/v1/`, kept current on writes within budget and by the shared maintenance pass.

- **Data model.** As architecture section 9: `manifest.json` (format, generation, health); `g/<gen>/nodes/<sha256(path)>.json` (path, observedSourceVersion, parser/resolver versions, referenceSetVersion, occurrences, external URL keys, coverage, reverseRepair); paged postings under `incoming/`, `bare/`, `names/`, `urls/` (each page `{ key, entries: [{ source, referenceSetVersion }], next? }`, page size a constant, initial 256 entries). Prefix registered in `packages/shared/src/storageLayout.cjs`.
- **API.** `apps/mcp/src/graph/` (new): `projectNote(store, path, body, version)` (forward record + reverse deltas, conditional where supported), `reconcileGraph(store, budget)` (resumable pass driven by the existing search census), `graphHealth(store)`. Write path: `toolWriteNote` calls `projectNote` after commit within the P5 budget, recording leftover work as pending. Capability check selects the P4 mode.
- **Files.** `apps/mcp/src/graph/*.js`, `apps/mcp/src/tools/notes/write.js` (post-commit hook), `apps/mcp/src/search/maintenance.js` (one census feeding both projections), `packages/shared/src/storageLayout.cjs`, `apps/mcp/src/search/budget.js` pattern reused for `WRITE_ENRICH_SUBREQUEST_BUDGET`, `wrangler.toml` (hosted 80).
- **Tests.** Forward/reverse consistency under concurrent writers on a conditional store; lost-membership repair by reconciliation; interrupted cleanup recovered without a new note edit; budget exhaustion defers, never fails the write; encrypted notes contribute nothing; no hidden note affects another caller's postings view; B2-mode labelling; rebuild generation cutover keeps edits made during the build. Sabotage each guard.
- **PR.** "Phase 2: the link graph as a rebuildable derivative" (may split into "forward records" and "reverse postings and reconciliation").

## Phase 3: link integrity and exploration

**Goal.** Faster, still-complete reference repair on moves; backlinks and related notes for people and agents.

- **Data model.** A relation: `{ path, reasons: ("links_here" | "linked_from_here" | "shares_target" | "shares_url" | "related_text" | "nearby")[], evidence?: string }`, computed per caller over the visible subgraph only.
- **API.** Moves (`apps/mcp/src/tools/moves/references.js`) use reverse postings to find referrers when coverage is proven complete; otherwise, and always on P4 storage, the existing scan. `related_notes({ path, limit? })` gateway tool (read-only, `title` "Related notes"). Console: a panel under the note listing backlinks and related notes with their reasons; unresolved links shown on the note that has them.
- **Files.** `apps/mcp/src/tools/moves/references.js`, `apps/mcp/src/tools/related.js` (new), `apps/mcp/src/tools/schemas/` (definition), `apps/mcp/src/tools/dispatch.js`, the console's note view (`apps/mobile/features/console/panes/browsePane/`), control-plane file operation for the console's read.
- **Tests.** Move repair identical with and without the index on a complete index; incomplete index falls back to scan; B2 always scans; privacy invariance (adding or removing hidden notes, links and URLs changes nothing a team caller sees); hub penalty; tool not offered past its scope; panel renders reasons and an honest "may be incomplete" state. Protocol tool counts updated.
- **PR.** "Phase 3: backlinks, related notes, and index-assisted link repair".

## Phase 4: post-write candidates

**Goal.** Optional link leads on every `write_note`, after the commit and within budget.

- **Data model.** The `linkSuggestions` result block from architecture section 13.3 (`status`, `basedOnEtag`, up to 3 candidates with `path`, `section`, `signals`, short quoted excerpt), rendered as text plus `structuredContent` where supported.
- **API.** `detectChangedSections(before, committed)` (text diff mapped to heading intervals; skips link-only and formatting-only edits; on live-editing storage `committed` is the collaboration engine's merged text). `suggestLinks(store, scope, sections, budget)` over the Phase 3 retrieval core. `toolWriteNote` appends the block; `remember` passes an option that disables it.
- **Files.** `apps/mcp/src/graph/changes.js`, `apps/mcp/src/graph/suggest.js`, `apps/mcp/src/tools/notes/write.js`, `apps/mcp/src/tools/notes/remember.js`, `apps/mcp/src/mcp/instructions.js` and the `write_note` description (the section 13.2 guidance).
- **Tests.** Write succeeds and returns identically when suggestions are skipped, fail or time out; `remember` never returns suggestions; link-only edit does not loop; audience rule withholds private candidates for a team note; payload under 4 KiB; budget respected (subrequest count asserted); changed sections correct for duplicate and nested headings and merged collaborative text.
- **PR.** "Phase 4: optional link suggestions after a write".

## Phase 5: unified retrieval experiments

**Goal.** Close the coverage gap and measure graph value against full-coverage lexical search.

- **Data model.** Chunk sub-documents `path#c<n>` with `notePath` (reusing `commsIndex.js`'s sub-document fields), the 64,000-character cap with a `partial` coverage flag; tokenizer v2 terms; shard revisions referenced by exact key/digest in the conditionally published manifest (architecture section 12.6).
- **API.** `chunkNote(path, text, { target, max })` (headings, then paragraphs, then sentences); `tokenizeV2(text)` and `porter2(word)` in `search/text.js` (Porter2 in its own module, `search/porter2.js`) behind an index format version; rank fusion of lexical and graph candidate lists with bounded boosts. Indexer, query parser and the app's local search switch tokenizer together.
- **Files.** `apps/mcp/src/search/text.js`, `search/indexer.js`, `search/commsIndex.js` (generalized), `search/shards/*` (revisioned shards), `search/visible.js`, `apps/mobile/features/home/localSearch.ts`, bench reports.
- **Tests.** Porter2 against Snowball's published input/output word pairs (the full official vocabulary when available locally, otherwise a checked-in sample of it); chunking boundaries and caps; results deduplicated to notes; tokenizer v2 cases (Chinese, Japanese, Thai, accents, identifiers) identical between indexer and query; publication coherence under concurrent writers; the full ablation matrix B0 to B5 run and reported, with B2 versus B1 as the graph-value comparison. Tokenizer v2 and graph boosts stay off unless they win on the held-out set.
- **PR.** "Phase 5: full-note chunked search, tokenizer v2, and graph-assisted ranking (measured)".

## Phase 6: default-search replacement

**Goal.** One default search, if and when the owner decides (O2, P2).

- **API.** All search surfaces route to the bucket-native path; Fast Search settings and upsells removed; new D1 provisioning stopped; existing projections released through their current lifecycle.
- **Files.** `apps/mcp/src/search/d1/*`, `docs/decisions/search.md`, billing and console Premium surfaces.
- **Tests.** Existing search, blended search and self-hosted paths pass on the new default; D1 release keeps handles until deletion is confirmed.
- **PR.** "Phase 6: one default search" (held open for the owner's decision).

## Across every phase

- Test first, sabotage each guard, `pnpm architecture` with 0 errors, and no file over 1,000 lines.
- Each phase records its durable decisions in `docs/decisions/` (Phase 2 records O1).
- Each PR states what was verified (unit, runtime, live) and what was not.
