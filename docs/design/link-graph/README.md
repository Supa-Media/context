# Context: Link Graph and Unified Retrieval Architecture

**Status:** Design specification, reviewed against the code and corrected; not an implementation or benchmark report.  
**Date:** 2026-10-04 (corrected the same day; see [Review corrections](#review-corrections-2026-10-04)).  
**Repository baseline:** `Supa-Media/context`, commit `b5ad06c6937a4cf94724591f0af36ab008e9b1e9` (`main` at the time of the correction). The first draft cited `0057b63c` (2026-09-22), 461 commits older, as if it were current `main`; every repository claim below was re-checked against the new baseline.  
**Scope:** Markdown links, graph integrity, related notes, agent-assisted link authoring, and the path to one fast, private, higher-quality bucket-native search system.

**Navigation:** [Decisions](#3-decision-register) · [System boundaries](#5-system-boundaries) · [Storage](#9-bucket-native-graph-storage) · [Moves and repair](#11-moves-deletions-additions-and-repair) · [Retrieval](#12-shared-retrieval-architecture) · [Agent/MCP workflow](#13-agent-authored-contextual-links) · [Benchmarks](#17-benchmark-and-evaluation-plan) · [Implementation order](#18-required-tests-and-implementation-order) · [Remaining proof obligations](#20-explicit-limits-and-remaining-proof-obligations).

## Review corrections (2026-10-04)

A review against `main` at the baseline above confirmed most repository claims (the link scanner's supported forms and its deliberate refusal of reference definitions; the gateway and app link copies and their parity test; the search indexer's separate link extractor; the 2,048-character note cap; the 7,961-note fixture; PageRank neutral in v2; routing filters; encrypted notes excluded from search; `forwarding.js` stating it is not a reference index). It also found the following, now corrected in place:

| # | Finding | Where corrected |
|---|---|---|
| 1 | The baseline commit was 461 commits behind the `main` it claimed to describe. | Header; Appendix B links. |
| 2 | R10 pointed at tool definitions in `apps/mcp/src/index.js` (now 201 lines). Definitions live in `apps/mcp/src/tools/schemas/`; the write path is `apps/mcp/src/tools/notes/write.js`. | Section 4, Appendix B. |
| 3 | "Zero npm dependencies" was wrong: the gateway has one owner-approved runtime dependency, `@context/collaboration`. The rule is no new runtime dependency. | Sections 2.5, 20. |
| 4 | The Worker subrequest ceiling was missing. Search code is written against 50 subrequests per invocation (Cloudflare's free tier), and work deferred with `waitUntil` spends the same counter. | New section 16.3; sections 13.5, 18.2. |
| 5 | On storage with live editing, `write_note` hands text to the collaboration engine, which merges; the committed body can differ from the submitted content. | Section 13.4. |
| 6 | Context-managed buckets seal every stored object, which includes `.context/graph/`. | Section 9.1. |
| 7 | `remember` (a separate tool that writes through the same write path) did not exist at the old baseline. | Sections 13.2, 13.7. |
| 8 | The search index writes shards unconditionally and only the manifest conditionally (`apps/mcp/src/search/CONTRACT.md`), which confirms the risk section 12.6 describes. | Section 12.6. |

## Owner decisions (2026-10-04)

| # | Decision |
|---|---|
| O1 | **The reference index is approved.** This reverses the recorded position in `apps/mcp/src/forwarding.js` that Context keeps no reference index. It stands on the conditions in section 9: the index is a rebuildable derivative, every relationship it yields is validated against the source's current version, and it is never the authority for a canonical edit. When built, the reversal is recorded in `docs/decisions/` with what reversing it costs and the test that fails if it is reversed. |
| O2 | **Retiring Premium Fast Search is the goal, and the owner decides it.** The gates in section 17.7 produce the evidence; the retirement itself is a product and billing decision taken by the owner when that evidence exists, not an automatic consequence of the gates passing. |
| O3 | **Post-write suggestions may run on every `write_note`,** within the per-write budgets (sections 13.5 and 16.3). No new argument turns them on or off. Writes made by other tools (`remember`, moves, archive, proposals, forms) never return suggestions. |

## 1. Purpose

Context should make a workspace easier to retrieve from and navigate without turning its Markdown into a proprietary database. A person or agent should be able to follow a meaningful reference, find related material, reorganize files, and understand incomplete results without maintaining a second representation of their knowledge.

The target is **one search experience that is fast, private, and measurably better at retrieval, available by default**. The goal is to retire the separate Premium Fast Search capability if the bucket-native implementation meets the quality, latency, reliability, and cost gates in this document; the owner takes that decision when the evidence exists (O2). Premium is not a permanent second search architecture. A future optional capability with a demonstrated marginal cost may be priced separately; that does not justify withholding an equally affordable core retrieval capability.

The graph is a means to that end, not the objective. More edges, a larger visualization, and a higher link-acceptance rate are not success metrics by themselves. Nor does adding graph traversal inherently make a query faster: graph work adds reads unless it eliminates other work or reduces the agent's subsequent search effort. Both effects must be measured.

This document defines a **document-link graph**, not a graph neural network. No training, embeddings, graph database, or hosted model is required for the initial graph.

## 2. Product invariants

### 2.1 The bucket remains the source of truth

Canonical note content and attachments remain in the workspace's configured storage. Each workspace retains its own binding and security boundary; no multi-tenant prefix scheme is introduced. The customer's configured root prefix, when present, remains an adapter concern. Context does not rename user folders, insert mandatory IDs into frontmatter, or require a storage migration before ordinary notes work. These are existing repository invariants. [R1] [R2]

A link shown as authored in a note must be represented by that note's Markdown. Context may render the syntax differently, but it must not invent a persistent link that exists only in a private database. A proposed agent edit is not saved until the ordinary write succeeds. An offline draft or queued edit must continue to be identified as local work rather than as content already in the bucket.

Derived relatedness may appear beside a note without being written into it. It must be presented as derived relatedness, not as text or a reference the author supplied.

### 2.2 Ownership and portability are not performance options

All newly persisted graph indexes, reverse indexes, resolver catalogs, and text-search derivatives belong under `.context/` in the same workspace's bucket. Deleting graph/search derivatives must lose an optimization, not authored knowledge. Export and departure remain available independently of Premium.

**Not everything under `.context/` is disposable.** Assets, operational records, proposals, audit history, and the existing forwarding ledger have different purposes. Rebuilding the graph must not delete them. In particular, current Markdown cannot necessarily reconstruct the historical forwarding of a link held outside the bucket. The existing forwarding ledger is bounded and may expire under its existing policy; that is not permission for graph repair to discard it. [R2] [R4]

### 2.3 Privacy constrains computation, not only rendering

Authorization is resolved through the existing grant, membership, scope, and privacy machinery. The graph creates no new route to credentials, hidden notes, attachments, or other workspaces.

A restricted caller's graph ranking must use only the subgraph they may read. Private nodes must not influence visible degrees, common-neighbor scores, URL frequencies, relationship explanations, counts, or ranking. Filtering a globally computed score at the end is insufficient. Existing search already carries this principle for corpus statistics. [R5] [R6]

### 2.4 Context supplies retrieval; the user's agent supplies judgment

The default linking workflow makes **no Context-hosted LLM call**. It does not invoke a query-planning model, an independent verifier, or a hidden agent. It does not require MCP sampling or a conversation/session ledger.

Context detects changed content, retrieves candidates, resolves paths, enforces access, and performs conditional writes. The user's existing agent decides whether a relationship is meaningful and writes any resulting link into ordinary prose.

### 2.5 Existing mechanisms are reused before new ones are introduced

Reuse the storage adapter and capability probes, privacy engine, mutation paths, forwarding behavior, link semantics, search entry points, budget accounting, census, and reconciliation infrastructure.

Reuse means sharing the actual implementation or a tested compatibility contract, not copying a description. The current repository already has multiple runtime copies of link behavior and parity tests. It also has a separate search link extractor whose behavior differs from the rename engine; consolidating that is part of this work. [R3] [R7] [R8]

The gateway's dependency and self-hosting constraints remain in force: its one runtime dependency is the owner-approved `@context/collaboration` boundary, and this work adds no other. `remark` is a possible parsing technology to evaluate, not a dependency already installed or approved by this architecture. [R1] [E5]

## 3. Decision register

The following register preserves the final direction of the design discussion. Concrete formats, initial budgets, and algorithms introduced later are implementation proposals under these decisions, not claims that every parameter was separately approved.

| ID | Decision | Consequence |
|---|---|---|
| D01 | Canonical content stays in the customer's configured bucket. | No external graph database or required hosted content copy for the new baseline. |
| D02 | One default search experience: fast, private, higher-quality. | Retirement of Premium Fast Search is the target, subject to evidence, and decided by the owner (O2). |
| D03 | Canonical mutations need strong, capability-backed safety; derivatives may converge eventually. | An index failure never rolls back a successful note save. |
| D04 | Use existing Markdown link behavior. | Preserve supported relative, rooted, bare, alias, anchor, and embed forms; no second resolver dialect. |
| D05 | Context-managed moves maintain references by default. | Rewrite actual Markdown targets, preserving surrounding bytes and respecting write authority. |
| D06 | External changes are reconciled from storage. | Events accelerate discovery; uncertain external renames are flagged, not guessed into canonical edits. |
| D07 | Identity is workspace binding + path + observed source version. | No mandatory stable note ID, hidden frontmatter ID, or content-hash identity. |
| D08 | Use per-note graph facts plus targeted reverse indexes. | Update changed facts, not every pair of potentially related notes. |
| D09 | Store direct references; derive most relatedness. | Shared targets, graph proximity, shared URLs, lexical similarity, and directory proximity are not automatically authored edges. |
| D10 | Share one candidate-retrieval core. | Search, related notes, and write suggestions use different seeds and intent, not independently evolving engines. |
| D11 | BM25/BM25F remains the lexical foundation. | Graph evidence assists retrieval; it does not replace text coverage. |
| D12 | Traverse locally and within budgets. | No all-pairs distance matrix or obligatory whole-graph load. |
| D13 | Surface relationships in the note view and existing retrieval paths. | `related_notes` is useful but not the only door to graph value. |
| D14 | Use shared URLs as a weaker, separately identified signal. | Citing the same URL is not the same as explicitly linking two notes. |
| D15 | Use directory proximity as a cheap hint. | Same directory is neither proof of a relationship nor a reason to write a link. |
| D16 | The user's agent authors meaningful, contextual links. | No automatic semantic link insertion by Context. Zero new links is valid. |
| D17 | Keep `write_note` as an ordinary write. | No prepare/commit modes or mandatory authoring transaction. |
| D18 | Return bounded post-write candidates after substantive changes. | Suggestions are optional; the write remains successful if candidate work is skipped or fails. |
| D19 | Derive candidate seeds from the submitted text. | No required or optional `sources_used` field in the initial design; no attempt to infer actual reading history from text. |
| D20 | Detect changed sections deterministically. | No model is asked what changed; structural analysis never rewrites the document wholesale. |
| D21 | Reuse one census and maintenance pipeline. | Avoid a second bucket walk for the graph or URLs. |
| D22 | Benchmark quality, speed, privacy, robustness, and ROI. | No state-of-the-art claim or price-tier retirement without comparable measurements. |
| D23 | Defer heavier mechanisms. | Personalized PageRank, learned rankers, embeddings, and LSM-style segments are experiments, not initial requirements. |

### 3.1 Clarifications that strengthen the decisions

These resolve problems in earlier descriptions rather than silently changing the product:

| Earlier shorthand | Precise architecture rule | Why the distinction matters |
|---|---|---|
| “Canonical state is ACID-like.” | Single-object atomicity and conditional mutation where proven; multi-object moves are recoverable workflows, not whole-bucket ACID transactions. | A copy, deletion, privacy adjustment, and many link edits can partially complete. [E1] [R9] |
| “Outgoing links and backlinks live in one small object.” | The per-note forward record is independently owned; reverse postings are separate maintenance-owned records. | Many sources writing one target must not overwrite that target's own facts or lose each other's backlinks. |
| “Parse the AST and find the parent heading.” | Build heading intervals from document order, then map changed source ranges to them. | In mdast, headings and the following paragraphs are normally siblings, not nested section parents. [E5] |
| “A tiny edit is non-semantic.” | Skip only narrowly recognized non-substantive changes; do not use a character-count threshold as a meaning detector. | Changing `can` to `cannot`, a number, a URL, or a link target may be small and important. |
| “Suggestions run asynchronously and return with the write.” | Suggestions run after the canonical commit but before that response, under a short deadline; durable maintenance can run after the response. | Completed responses cannot later acquire extra fields. |
| “Cache aggressively.” | Cache only under explicit tenant, binding, version, authorization, memory, and retention rules; never cache decrypted storage credentials across requests. | A warm cache is not a new authorization system or durable content store. [R2] |
| “Everything can be rebuilt.” | Graph/search derivatives can be rebuilt; forwarding history and unrelated operational state are outside that deletion boundary. | Current files do not encode every historical move. [R4] |
| “The same hash means the file moved.” | Content equality is evidence for a repair suggestion, never unique identity. | Copies, duplicate notes, concurrent edits, and path reuse are indistinguishable from some renames without additional evidence. |
| “The proposed workflow is the consensus/SOTA.” | It is a product-fit design hypothesis that must beat appropriate baselines. | Research on agent memory does not establish the optimal protocol for arbitrary third-party MCP clients. [E7] |

## 4. Existing system and integration points

At the reviewed revision, the repository already contains:

| Area | Existing foundation | Required treatment |
|---|---|---|
| Storage layout | `packages/shared/src/storageLayout.cjs`; search under `.context/search/`. | Add a versioned graph prefix centrally; do not recreate retired top-level dot folders. |
| Note links | `apps/mcp/src/links.js` and `packages/shared/src/links.ts`. | Preserve the established resolver and target-span rewriting contract; keep parity across runtimes. |
| Forwarding | `apps/mcp/src/forwarding.js`; `.context/forwarding.json`. | Reuse bounded path-history semantics. Do not turn it into note identity or replace it with the graph. |
| Bucket search | `apps/mcp/src/search/CONTRACT.md`; sharded BM25F with vocabulary routing filters. | Extend the shared retrieval path, not a parallel graph-only search product. |
| Search extraction | `apps/mcp/src/search/indexer.js`. | Replace its divergent link extraction with the common contract. Rebuild affected derivatives, not user Markdown. |
| Search safety | Visible-corpus statistics, current access checks, live snippets on the bucket path, explicit incomplete/reduced-recall signals. | Preserve these at every new relationship surface. |
| Fast Search | Opt-in, Premium-gated D1 projection described in `docs/decisions/search.md`. | Keep as a measured baseline and temporary rollout fallback, not the desired end state. |
| Writes and MCP | Tool definitions in `apps/mcp/src/tools/schemas/`; the write path in `apps/mcp/src/tools/notes/write.js` (`write_note(path, content, expected_etag, …)`), also used by `remember`. | Add optional result information to `write_note` only; preserve existing arguments, mutation semantics, and transport compatibility. |
| Moves | Existing move/archive/folder paths and partial-move audit behavior. | Integrate link maintenance and report the actual completion state. |
| Offline and collaboration | Mirror, outbox, conflict resolution, and live editor behavior in the app. | Index committed versions only; preserve drafts, conditional replay, and existing conflict decisions. |

The current bucket index limits ordinary-note indexing to the opening 2,048 characters and has additional finite shard/manifest capacity. Message bundles use sub-documents but can still experience reduced recall. PageRank is explicitly neutral in the v2 path; that is not a requirement to restore it. [R5] [R6]

Historical measurements in the repo are useful for reproducing a baseline, not proof of this proposal. For example, its 7,961-note fixture measured approximately 188 ms for a one-note term and 752 ms for a ubiquitous term with simulated 60 ms store latency. Those are fixture measurements, not live measurements of this graph architecture. [R6]

## 5. System boundaries

```text
User / user's agent / Context UI
              |
              | existing authenticated API / MCP tools
              v
       Request authorization
       + existing storage adapter
              |
     +--------+------------------------+
     |                                 |
     v                                 v
Canonical mutation               Shared retrieval core
conditional note save            lexical + bounded graph
or recoverable move              + URL/directory evidence
     |                                 |
     | commit first                    | current visibility
     v                                 | + source evidence
Bounded post-write candidates           v
     |                           Results / related notes
     v
Ordinary success response
+ optional suggestions
     |
     | user's agent may read candidates and write again
     |
     +---- change hints ----> Shared maintenance/reconciliation
                                     |
                                     v
                         Customer's workspace bucket
                         + Markdown and attachments
                         + .context/search/ derivatives
                         + .context/graph/ derivatives
                         + existing operational records
```

The compute executing retrieval is the existing trusted gateway/file-operation runtime, or a supported self-hosted deployment. The object bucket stores data; it does not execute BM25 or graph traversal by itself.

“Private bucket-native search” means the new design requires no persistent external search copy or hosted inference service. It does **not** mean the hosted gateway never sees readable note content, that the bucket is physically on the user's device, or that the design is end-to-end encrypted. The existing encryption feature and offline copy have their own contracts. [R1] [R10]

## 6. State, consistency, and authority

### 6.1 Three classes of state

| State | Examples | Rule |
|---|---|---|
| Canonical user content and access policy | Markdown, attachments, `privacy.md` | Existing conflict-safe mutation and access rules; never rewritten merely to repair an index. |
| Operational state | Audit, forwarding, existing move/recovery records, unsent drafts | Preserve according to its own contract. A graph reset does not own it. |
| Reconstructable derivatives | Forward graph facts, reverse postings, URL/name catalogs, text index, retrieval caches | Eventually consistent, versioned, bounded, replaceable, and recoverable from current authoritative inputs. |

Eventual consistency does not permit arbitrary data races. Each derived object still needs structural validation, safe publication, and a repair path. Access control is never downgraded to eventual consistency merely because an index is derived.

### 6.2 Mutation guarantees

A write returns success only after the canonical write is confirmed. Updates carry the version read by the caller; creates use create-only semantics where supported. A conflict is not automatically retried against an unseen newer version.

Provider capability is a measured property of the configured endpoint. Conditional create, update, and delete are separate capabilities. A read-compare fallback does not provide atomic compare-and-swap against external writers; it must remain honestly described as weaker. Automated canonical repair that depends on atomic protection is withheld on an unproven backend rather than silently made unconditional. Ordinary operations retain the repository's documented fallback behavior. [R1] [R2] [E2]

Object-store ETags and revision tokens are opaque validators. Do not sort them to decide which version is newer, assume they are content hashes, or equate an index revision with a note's durable identity.

### 6.3 Multi-object operations

A move may include a destination create, source retirement, access-policy work, forwarding, and several referrer edits. There is no general atomic commit over that set of object keys. Therefore distinguish:

- The move was refused before mutation.
- The move completed, but some reference maintenance needs repair.
- The move partially applied and its actual surviving objects are reported.
- The outcome is unknown because a request's response was lost.

Never describe “we issued several conditional writes” as an all-or-nothing rename. Compensation must not delete a destination another writer has since modified. Audit and existing recovery behavior must describe what actually happened. [R9] [E1]

### 6.4 Freshness

Track source version, parser/resolver version, index generation, and observation time separately. A fresh poll of a manifest is not a fresh scan of the bucket.

A graph record may be current relative to the last observation and still behind an external edit. A read that knows its note's latest version can immediately reject an older graph record. Across several independently edited notes, the normal result is a bounded, version-observed view, not a transactional snapshot of the workspace.

Report `ready`, `behind`, `unavailable`, and `partial` honestly. Preserve the existing distinction between **still indexing** and **reduced recall because a capacity limit was reached**. Neither is “no matches.” Unknown or incomplete scans are never evidence of deletion.

## 7. Link semantics and the canonical resolver

### 7.1 References come from the file

Extract supported links from the **full supported Markdown body**, independently of the text-search index's character cap. Each occurrence records its written target and source span. Deduplicate graph adjacency by target while retaining occurrence information for repair and evidence.

The existing engine recognizes wikilinks, aliases, anchors, note embeds, and inline Markdown links; it masks code fences and code spans. Reference-definition links are not currently maintained. It is not a complete CommonMark AST parser, and the new architecture must not describe it as one. [R3]

The resolver contract must cover parsing, navigation, graph extraction, rewrites, and suggestion insertion. A form that is displayed as maintained must also be repairable by that contract. Unsupported reference definitions, HTML attributes, and unfamiliar plugin formats are preserved rather than partially rewritten. Support can be expanded with fixtures and an explicit format-contract revision.

### 7.2 Preserve the current path dialect

Use the existing resolver's semantics, not a generic URL resolver's guesses:

| Written target | Existing interpretation to preserve |
|---|---|
| `./plan` or `../decisions/plan` | Relative to the referring note's directory. |
| `1-projects/example/plan` | Rooted within the workspace's configured logical root. |
| `plan` | Bare-name lookup; resolve only when the relevant authorized catalog gives a unique answer. |
| `note#heading` or `note#^block-id` | Note target plus separately preserved fragment. |
| `#heading` | Within-document anchor; not a cross-note graph edge. |
| Scheme-bearing or protocol-relative URL | External to the ordinary note-path resolver. |
| A resolved non-Markdown path | Attachment reference, not automatically a note vertex. |

The `./` in a same-directory relative link is significant: removing it can change a position-based reference into a workspace-wide bare-name lookup. Preserve relative versus rooted style, extension conventions, aliases, anchors, and embed markers. [R3]

Normalize `.` and `..` only within the established path grammar. Reject root escape rather than clamp it to a different target. Retain case-sensitive logical keys and existing decoding rules; malformed escapes, encoded separators, Unicode variants, and reserved paths require compatibility/security fixtures, not incidental normalization.

### 7.3 Resolution is not existence

Separate the following internal states:

| State | Meaning |
|---|---|
| `resolved` | A supported reference binds to a permitted, observed target. |
| `missing` | An authoritative check establishes no accessible target. |
| `ambiguous` | More than one permitted candidate satisfies the supported lookup. |
| `unknown` | The catalog or target was not sufficiently observed to decide. |
| `invalid` | The target violates path or syntax rules. |
| `unsupported` | The form is preserved but not understood by this resolver. |
| `external` | A URL/reference outside ordinary note resolution. |

These are not all public error codes. A caller must not distinguish a forbidden target from a nonexistent one. Do not print “hidden target exists” or a hidden ambiguity count. Even a diagnostic is filtered output.

A syntactically valid path returned by `resolveLink` is not proof the target exists. Conversely, absence from a partial index is not proof it does not exist. Verify against the current authorized inventory or a permitted direct read when needed.

### 7.4 Bare names require late binding

Persist the original bare target as well as any cached binding. An owner-wide resolution must not become authoritative for every restricted reader: a private duplicate basename must not change what a team caller can infer.

The shared catalog therefore supports both **notes named X** and **references written as X**. Resolve those against the caller-visible catalog at query time when necessary. Backlinks to a note combine exact-path references with bare references that uniquely resolve to that note in the caller's view.

Adding, deleting, or renaming a note can change bare-name resolution even when no referring note was edited. Invalidate or recompute those bindings using the name postings and resolver-catalog version. Do not wait for every referrer to receive a new ETag.

Canonical repair remains conservative: apply only an unambiguous mapping under the supported, authorized resolver contract. Prefer an explicit path for a newly authored link when a basename is ambiguous. Never introduce a shortest-path heuristic merely because another editor uses one.

### 7.5 Patch, do not serialize

Automatic rename repair replaces the exact target spans in the original Markdown, working from the end of the file toward the start. It does not regenerate the document from an AST.

Untouched prose, formatting, whitespace, line endings, frontmatter, reference labels, code, and unrelated plugin metadata stay byte-for-byte unchanged. Re-read and recompute the patch after a version conflict; never apply stale offsets to a different body.

A heading change does not justify guessing a replacement fragment. Preserve fragments during path moves; validate supported anchors separately. A note may exist while its old heading no longer does. Block IDs and heading slugs follow their existing grammar, and duplicate headings need deterministic disambiguation.

### 7.6 Structured or untrusted content

A fenced message body remains quoted content rather than authored graph structure. The communications renderer's decision not to linkify message bodies is preserved. URLs inside those bodies are not silently promoted into the authored graph. A future quoted-reference signal would need separate trust labeling and evaluation. [R8]

Drawings are interpreted through the existing drawing parser, not by searching compressed payloads for bracket patterns. Attachments remain subject to the existing reference-based access gate. An image reference does not grant access to every other note that embeds that image.

Encrypted notes do not contribute decrypted vocabulary, outgoing relationships, or URL references to a plaintext persistent derivative. Preserve the current exclusion from search; encryption-aware graph indexing is not smuggled in as maintenance. A visible note may contain a written reference to an encrypted note, but no hidden contents are inferred from it. [R10]

A transition to encrypted storage also needs cleanup of derivatives produced while the note was plaintext. Stop serving those facts once the transition is known, invalidate matching caches, and track removal from active and retained graph generations explicitly. A successful note encryption is not proof that every old derivative or provider-retained version was erased. Use the existing encryption lifecycle for the user-facing outcome, report any outstanding cleanup honestly, and do not claim retrospective secure erasure of backups or versions this service cannot delete.

## 8. Relationship model

### 8.1 Persist facts, calculate relationships

| Relationship | Persisted input | Read-time interpretation |
|---|---|---|
| A explicitly references B | Link occurrence in A; derived forward/reverse postings. | Directed reference with evidence in A. |
| B links to A | The same A/B reference, read in reverse. | Backlink; not a second authored link. |
| A and B cite C | A → C and B → C. | Shared linked note, a two-edge connection, not A → B. |
| C cites both A and B | C → A and C → B. | Common referrer, separately labeled. |
| A reaches B through a short path | Existing explicit edges. | Bounded graph proximity; preserve direction/type information. |
| A and B cite the same URL | URL occurrences and URL-to-note postings. | Shared external reference, not agreement or an explicit note-to-note edge. |
| A and B have similar text | Existing lexical search index. | Query-time text relatedness; no permanent similarity edge. |
| A and B are near in the folder tree | Actual note paths. | Directory proximity; weak supporting evidence. |

The relationship's meaning in an authored note lives in the sentence around the link. The graph does not require users to maintain predicates such as `supersedes` or `contradicts` in a proprietary edge schema. Deterministic extraction can say a link exists; it cannot certify the truth of the prose describing it.

### 8.2 URL handling

URL extraction is offline parsing, not web crawling. No redirect following, remote metadata fetch, canonical-tag lookup, favicon request, or automatic link-health request is required. Opening a note must not notify external sites that its owner read it.

Use a versioned, conservative URL-key function. Normalize only equivalences the selected URL parser actually guarantees, such as scheme/host casing and an explicit default port. Preserve path case, meaningful query parameters and their order, fragments, and distinct schemes unless a separately tested rule proves an equivalence. Do not collapse every URL on one domain into the same reference. [E6]

Store the written URL occurrence with the note facts; use a hash of the canonical comparison key to address its reverse posting list. A hash is an index key, **not encryption or anonymization**. Raw URLs, hashes, and query parameters remain private derivative data and do not enter telemetry.

Exclude URLs recognized as credentials, bearer/share tokens, signed download URLs, or user-info-bearing addresses from shared-reference ranking by default. Do not silently strip a secret and then group unrelated references by the remainder. Unknown URLs stay un-fetched; a heuristic detector is not a guarantee that every secret-bearing URL is recognized.

A frequently cited homepage is weaker evidence than a specific document. Compute any frequency penalty over the caller's visible notes, count each note once per comparison key, and cap contribution. URL normalization never edits the original Markdown.

### 8.3 Directory proximity

For directories represented as path segments:

```text
directory_distance(A, B)
  = depth(dir(A)) + depth(dir(B))
    - 2 * depth(longest_common_directory_prefix(A, B))
```

Same directory has distance zero; sibling directories have distance two. Calculate this from paths for the candidates under consideration. Do not store an all-pairs directory-distance matrix.

Use actual keys, including the customer's sort prefixes, not display labels. An `inbox`, `archive`, import directory, or large root directory may group unrelated notes. Directory evidence is weak, saturating, and never sufficient on its own to insert a Markdown link. A directory move updates this signal from the new paths without creating thousands of semantic edges.

### 8.4 Prevent a dense, self-reinforcing graph

Repeated occurrences of one target do not create repeated adjacency votes. Shared boilerplate, generated navigation, front pages, and high-degree hubs must not dominate every result. Normalize common-neighbor contributions by visible degree, bound hub expansion, and evaluate generated/ingested content separately.

Do not reward the count of links an agent creates, automatically reciprocate links, or write similarity suggestions back as durable edges. Otherwise the system can manufacture the evidence that makes its own next suggestion appear strong.

## 9. Bucket-native graph storage

The forwarding module previously argued against maintaining a separate reference index because it could drift from the files. The owner approved reversing that choice (O1); this design changes it, not the underlying ownership rule: the graph is an optional, source-version-validated and reconciled derivative, never the authority for a canonical edit. The forwarding ledger continues to record only path history. Reusing its contents as the graph, or trusting stale backlinks for a rewrite, would restore the failure that objection identified. [R4]

### 9.1 Logical layout

The following is the proposed v1 layout. Exact encoding and page thresholds are tuning details; the ownership and separation are not.

```text
.context/
  manifest.json                  existing storage-layout manifest
  forwarding.json                existing path-history ledger; not graph-owned
  search/                        existing text-search derivative
  graph/
    v1/
      manifest.json              format, active generation, compatibility, health
      g/<generation>/
        nodes/<path-hash>.json   forward facts for one note
        incoming/<target-hash>/  reverse postings for exact note targets
        bare/<name-hash>/        sources with a written bare-name reference
        names/<name-hash>/       note paths eligible for that name lookup
        urls/<url-hash>/         sources citing a comparison URL
        maintenance/             bounded cursors and repair bookkeeping
```

Each large posting list has a small directory and bounded pages. Most notes and references need one small record/page. The graph manifest contains no full-note body, global adjacency matrix, or mandatory list of every note. Its generation pointer changes for a rebuild or format transition, not for every edit.

In a Context-managed bucket every stored object is sealed at rest, including these (`withManagedEncryption` wraps the storage adapter beneath every caller). That needs no graph-specific code, but each sealed object adds about 98 bytes and a seal or open costs roughly 0.3 ms, so many small reverse pages cost more there; measure page sizes on a managed bucket as well as a customer one.

The node locator is deterministic from the exact logical path, for example SHA-256 of its UTF-8 representation. The record also stores that path and validates it on read. This locator changes on a move; it is not a stable note ID. All runtime keys additionally include workspace and binding identity, because identical paths in different buckets are different data.

### 9.2 Forward record

A logical node record contains:

```text
formatVersion
path
observedSourceVersion
observedAt
parserVersion
resolverVersion
referenceSetVersion
outgoingOccurrences[]   // kind, written target, target span, fragment, style
externalReferences[]    // eligible comparison keys + versioned source positions
resolutionHints        // non-authoritative cached bindings/catalog version
coverage               // complete / partial / unsupported / excluded
reverseRepair          // outstanding affected posting keys, if any
```

Store no second full note body merely to build the graph. Evidence snippets are extracted from permitted source reads when needed. Source spans are meaningful only against the recorded source version.

`referenceSetVersion` identifies the normalized reference set, not the identity of the note. An edit that changes prose but not references updates the forward record's observed version without rewriting every reverse posting. Resolver or URL-normalization changes can invalidate this fingerprint intentionally.

Large forward records use bounded overflow pages or explicitly report partial coverage; the implementation must not silently keep the first few links and call the graph complete.

### 9.3 Reverse records

A reverse posting names a source path and the reference-set revision that justified its membership. A source edit adds/removes that source's membership from the affected target/name/URL lists. It does **not** rewrite every other source that happens to share them.

This makes a URL shared by 1,000 notes one reference hub with 1,000 memberships, rather than approximately half a million materialized note pairs.

Forward and reverse records have independent object versions and writers. No caller may replace a whole target's backlink array from an old snapshot. Page-level changes use conditional compare-and-swap where verified, retry by re-reading and merging, and stop under bounded conflict budgets.

A reverse posting is an accelerator, not proof. Validate its membership against the source's current usable forward record before deriving a relationship. Mismatched or unverified memberships are dropped or returned as unavailable evidence, never used to mutate Markdown.

### 9.4 Partial publication and concurrent maintenance

Source facts and all affected reverse pages are not atomically committed together. Preserve recoverability explicitly:

1. Read the newest source and existing forward record.
2. Compute the new facts and the union of old, new, and previously pending reverse keys.
3. Conditionally publish the forward record **with its outstanding reverse-repair work**.
4. Reconcile each affected reverse membership against the latest usable source record, not blindly against an old event delta.
5. Clear the repair marker only with a conditional update that still describes the same source/reference-set revision.

A newer source edit merges outstanding cleanup work rather than erasing it. A delayed older reverse write may temporarily create an unusable posting; source-revision validation prevents treating it as current, and recurring integrity work repairs it. An interrupted removal must not survive forever just because the source ETag no longer changes.

If pending work becomes too large for its bounded record, mark that portion for a rebuild and retain honest partial status rather than silently dropping repair obligations. Recovery bookkeeping remains a derivative; a full rebuild from notes can replace it.

Read the expected forward-record revision before fetching the source version to project. Publish against that same record revision; after a conflict, re-read the source as well as the record rather than retrying stale event content against a newer head. A queued committed-body hint must be checked against the currently observed source before it replaces a newer projection. ETags establish equality, not version order. Source changes after observation are handled by the next authorized update/reconciliation; this does not create a transaction between the note and its graph object.

The guarantee is convergence when source changes settle and authorized maintenance continues, not a transactional graph snapshot or exactly-once processing. A lease may reduce duplicate work, but an expiring lease alone is not proof that a delayed worker stopped. Conditional publication and source-version checks remain necessary.

### 9.5 Providers without conditional publication

Do not claim that read-compare implements safe multi-writer posting updates. Such a backend can still serve an observed, validated derived graph, but overlapping maintenance can lose updates until reconciliation.

The implementation must either use a proven publication mechanism available on that backend, provide an explicitly weaker single-writer/rebuild mode, or withhold the affected acceleration and use the working lexical fallback. Single-flight inside one Worker isolate is not a distributed lock. Do not introduce a mandatory external coordination database merely to hide an unsupported storage capability.

### 9.6 Rebuild generations

Build a fresh generation without mutating the active generation's format. Re-read changed source versions, replay observed dirty work, and publish the new generation only after its coverage and reverse-index checks pass. A writer targeting the prior generation after the switch must trigger repair of the active generation; the cutover must not lose edits made during the build.

Readers pin the generation for the request. Retain the old generation for a bounded rollback/in-flight-reader window, then garbage-collect only graph-owned derivative objects. A newer unknown format is not parsed optimistically, and an older client must not clear state it does not understand.

This use of versioned objects is not an LSM engine. It does not introduce write-ahead segments, an unbounded delta log, or regular compaction as an initial requirement.

## 10. Change detection and reconciliation

### 10.1 One census, several projections

Extend the existing listing/ETag maintenance pass with a shared stream of observed source changes. A source body fetched once in that pass can feed full-body link extraction, URL extraction, and the appropriate text-index adapter. The graph does not start its own full workspace walker.

The census is shared, but projection progress is not conflated. A note may be current in text search and behind in the graph, or the reverse. Each projection records its own successful version and coverage. A common “all done” bit must not make one projection's failure invisible.

Context-managed writes already know the committed path, body, and returned version. Use those as change hints and avoid an immediate re-list solely to rediscover them. Coalesce repeated updates to one path, and read the latest version when a worker catches up; processing every autosave as a separate full indexing job would amplify cost without preserving additional canonical truth.

### 10.2 Events are optional accelerators

An authenticated bucket event can enqueue a path for inspection. Events may be delayed, repeated, missing, or out of order. AWS documents at-least-once delivery, not a transactional stream of application-level moves. [E3]

An event receiver must validate the configured subscription/provider proof and map it through the existing storage binding. A workspace ID in an untrusted event is not authority to obtain that workspace's credential. A notification about `.context/graph/` must not recursively trigger graph re-indexing.

Do not infer a rename solely from a create/delete pair. The default path works without provider-specific events. Event configuration and any associated provider charges are optional and disclosed.

### 10.3 Reconciliation is the correctness backstop

Run bounded, resumable passes through existing authorized scheduling/request mechanisms. Persist scan progress, distinguish a complete scan from a truncated one, and fairly rotate integrity work. Repair must not depend forever on “spare budget” that a large workspace never has.

A pass:

```text
load compatible projection state
    -> resume the shared source census
    -> detect new/changed/authoritatively removed sources
    -> fetch changed bodies within budget
    -> refresh forward facts and affected postings
    -> invalidate changed name bindings
    -> audit a bounded portion of unchanged records/postings
    -> publish accurate progress
    -> continue only while authorized, budgeted, and making progress
```

Do not infer deletion from an incomplete listing, a failed page, an expired cursor, an authorization narrowing, or a provider that ignores the resume position. An authoritative per-path not-found can invalidate that path independently. A multi-page listing is not automatically a snapshot across concurrent writes; repeat or version-check affected ranges before destructive conclusions.

Deletions update derivatives, not other notes' prose. Referrers retain their written links and become unresolved until repaired or intentionally edited.

### 10.4 No new credential bypass

Reuse the repository's request-time binding resolution and existing internal credential barrier. Scheduled work rechecks the binding, generation, and authorization conditions that permit it. No new endpoint may accept an arbitrary workspace ID and a platform secret as sufficient authority to read every customer's notes. Do not persist decrypted credentials or note bodies in scheduler arguments. [R2]

A hosted scheduler, an active client, or supported self-hosted maintenance must actually be running for convergence. Do not promise that an idle self-hosted workspace with no trigger will refresh within a fixed number of seconds. Freshness limits are deployment-dependent service objectives, to be measured and exposed where meaningful.

### 10.5 Rebuilding a reverse index

A corrupt forward record can be recreated by parsing its source. A reverse list cannot generally be rebuilt by reading only the target: it describes links written in **other** notes. Repair it from usable source records, with canonical rechecks as needed, or rebuild the generation from the source census.

This distinction limits the earlier “delete one node and rebuild it” shorthand. Repair remains local where the required evidence is local; it must not claim that one target read reconstructs every backlink.

## 11. Moves, deletions, additions, and repair

### 11.1 A Context-managed move

Preserve the current move's authorization, conflict handling, source/destination protection, privacy behavior, forwarding, and audit contract. Replace the expensive search for referrers with reverse-index lookup only when its coverage is sufficient.

```text
authorize the requested move and affected write surface
    -> read/prove source version and destination conditions
    -> obtain supported old-path -> new-path mapping
    -> identify referrers and moving notes
    -> perform the existing safe move workflow
    -> patch references conditionally under that mapping
    -> record confirmed forwarding and actual outcomes
    -> invalidate old/new graph, catalog, and text-index locations
    -> report move and reference-repair outcomes separately
```

For a folder move, repair both references **to** the moved subtree and relative references **inside** it that point elsewhere. A blind string substitution cannot do the latter correctly.

A reverse index is an optimization for locating referrers, not a completeness oracle. If it is behind, either use the existing bounded scan to establish coverage or report that reference repair is incomplete/not completed. Never claim all links were fixed because all *indexed* referrers were visited.

Do not elevate a team caller to repair private notes. Deferred derivative maintenance can use its existing authorized indexing scope; deferred **canonical edits** need appropriate write authority of their own. An indexer's access to plaintext is not permission to rewrite it on another caller's behalf.

### 11.2 External edits and suspected moves

External writes update graph facts on observation. If an old path disappears and a new path appears, Context may generate an owner-visible repair candidate using retained history, provider-supported evidence, content comparison, and surrounding references.

Without an authoritative mapping, represent this as a possible move, not a resolved identity. Identical content can be a duplicate; a moved file may also have been edited; names and timestamps are not proof. Ask the authorized user/agent to confirm before changing canonical references. An unconfirmed match does not enter the forwarding ledger as fact.

Context may automatically repair **derived indexes** from current files. It may automatically repair **canonical link text** for a confirmed Context-managed move or another explicitly authorized, verified mapping. These are different permissions.

### 11.3 Scenario contract

| Scenario | Required behavior |
|---|---|
| New note without links | Index normally; no graph-density requirement. Eligible substantive prose may receive suggestions. |
| New note satisfies a previously missing target | Re-resolve affected target/name postings even if referrers did not change. |
| A duplicate basename appears | Re-evaluate relevant bare references; preserve ambiguity rather than silently retargeting. |
| A note's prose changes but references do not | Update the observed source version/evidence; avoid unnecessary reverse writes. |
| A note adds/removes a reference | Update its forward facts and the affected reverse memberships; no pairwise-relatedness fan-out. |
| A note moves within a folder | Re-express inbound and self/relative references with the existing style rules. |
| A note moves to another folder | Also recompute its own relative outward links and directory evidence. |
| A folder moves | Apply the full mapping to inward, outward, self, and intra-subtree references. |
| A destination already exists | Refuse rather than overwrite; no implicit merge or guessed suffix. |
| A case-only rename or Unicode lookalike | Use exact logical keys and adapter capabilities; do not apply device filesystem assumptions to bucket identity. |
| A source/referrer changes during repair | Preserve the newer text, record the conflict, and re-read/re-plan before retrying. |
| A batch partially applies | Keep confirmed outcomes and audit them; do not label the batch atomic. |
| A request times out | Treat outcome as unknown until verified; do not blindly repeat a destructive action. |
| A note is archived | Maintain references to its actual archived location under the existing archive policy. |
| A note is deleted/trashed | Invalidate its indexed presence; leave authored referrers intact and report unresolved references appropriately. |
| A deleted note is restored | Recheck collisions, permissions, name bindings, and existing repair history before reactivation. |
| An old path is reused for a different note | New occupancy is not proof of continuity. Do not transfer historical sharing or inferred identity to the replacement. |
| A move occurs outside Context | Reconcile; flag suspected mapping; do not auto-rewrite on content similarity alone. |
| A file is copied | Treat it as a separate note, even with identical content. |
| A heading/block target disappears | Note existence and fragment validity remain separate; do not invent a new anchor. |
| Access narrows or a note becomes encrypted | Exclude disallowed evidence immediately on an authorized read; invalidate/purge affected derivative material through maintenance. |
| A binding is disconnected or replaced | Stop pending work for the old binding and discard its runtime caches; never reuse its graph for the new bucket. |
| The graph or a page is corrupt | Quarantine that derivative, retain canonical files, repair, and serve an honest fallback. |
| A listing is truncated | Do not delete absent entries or claim a complete graph. |
| Offline work changes a note | Keep the draft/outbox contract. Index the eventual committed body, not an unsent overlay as bucket truth. |

### 11.4 Path history and its limit

Keep exact-forwarding precedence, folder-prefix segment boundaries, bounded chains, and the existing ledger's retention behavior. Forwarding is useful for external stale references, but it does not make a path into permanent identity. [R4]

An ordinary current link whose old path has been reused can be inherently ambiguous: its bytes alone cannot reveal whether it meant the former occupant or the new one. Honor the current resolver's documented behavior and flag uncertainty when historical repair is attempted. Do not claim this ambiguity can be eliminated without adding identity information the design deliberately does not require.

Cross-workspace moves retain their separate existing authorization and recovery workflow. The initial graph is workspace-local. Cross-workspace search may fuse already authorized per-workspace results, but that is not permission to crawl another bucket through an edge or to persist a cross-tenant graph.

## 12. Shared retrieval architecture

### 12.1 One engine, different seeds

Use a shared internal candidate function with explicit intent and limits:

```text
retrieveCandidates(
  authorizedWorkspace,
  seed = query text | existing note | changed source ranges,
  intent = search | related_notes | link_suggestions,
  budget
)
```

`search` starts with the user's query. `related_notes` starts with a note's text and explicit neighborhood. `link_suggestions` starts with the committed changed prose, its heading context, existing written references, and its path.

The last case does not require a durable graph record for the newly written note. Use an in-request overlay of the facts extracted from the committed text, so suggestions do not wait for graph maintenance.

### 12.2 Candidate generation

1. **Lexical retrieval:** use the existing query/tokenization path and BM25F. For a note or section seed, deterministically select a bounded set of useful title/heading/body terms rather than passing thousands of raw words as a Boolean query.
2. **Explicit neighborhood:** inspect direct outgoing targets and permitted backlinks relevant to the seed.
3. **Bounded expansion:** explore a small, deduplicated neighborhood of selected lexical/explicit candidates, initially no more than two edge hops.
4. **Shared references:** use shared-target and eligible URL postings; do not enumerate every note pair.
5. **Directory hints:** score already selected candidates by directory distance; add a small nearby candidate set only when an existing authorized catalog/cache makes it affordable.
6. **Merge:** deduplicate by workspace and note path, retaining reasons and source evidence. Apply limits after authorization.

“No Context-hosted query planner” is literal. Term extraction, heading selection, and reference lookup are code. The user's agent remains free to formulate additional searches using its own reasoning, but the server does not secretly generate two to five semantic probes.

### 12.3 Ranking

Retain a lexical-only result set as the baseline. The proposed initial combination is a bounded graph/reference contribution rather than raw addition of incomparable score scales.

A possible initial formulation is rank fusion across independently ranked candidate lists, with bounded structural boosts. The exact constants are experiment parameters. Within a feature, normalize against the caller-visible data actually used, and record sampling/partial coverage. Do not present a BM25 score as a probability.

Important safeguards:

- An exact or strongly relevant lexical hit must not be buried merely because another note is a hub.
- A direct link is high-confidence evidence that a reference was authored, not proof that its target answers every query.
- Directory and shared-URL signals are weaker, capped contributions, not independent reasons to force a result.
- Graph expansion must not be required for a lexical hit to survive.
- Exactness/phrase/negation semantics must not be weakened by expansion. The current phrase behavior must not be silently upgraded in documentation without implementation.
- Unlinked notes must remain discoverable. An empty graph does not make a workspace unsearchable.
- An unavailable graph returns the working lexical result, with appropriate coverage information, rather than an empty answer.

For shared linked targets, distinguish A → C ← B from A → C → B. A common-neighbor score may use a Jaccard or visible-degree-penalized overlap. No global distance matrix, global PageRank, or precomputed universal popularity score is required.

For blended multi-workspace search, retain the existing principle of fusing **ranks**, not treating raw scores from different corpora as comparable. Keep graph expansion inside each authorized workspace. [R5]

### 12.4 Privacy-safe evidence and budgets

Visibility checks apply to seeds, candidates, intermediary nodes, shared targets, excerpts, counts, and explanations. A hidden intermediary may not be used to connect two visible notes. A shared URL found only in a hidden note contributes nothing.

Candidate truncation, common-neighbor selection, and hub penalties must operate on permitted candidates, not on a global top-k with forbidden rows removed afterward. Otherwise hidden notes can crowd visible results out even if their names never leave.

Mixed-visibility physical pages make this subtle under an I/O budget. An implementation that cannot obtain an authorized feature without hidden entries influencing its observable selection must not serve that feature as privacy-safe. It needs a visibility-safe lookup/partition/cache strategy or must withhold that optimization for the affected scope until its invariance tests pass. Live authorization still applies to any cached/partitioned view.

No constant-time security claim is made: network timing, shared infrastructure, and page sizes require separate threat analysis. The release requirement is that hidden content not influence the returned paths, values, rankings, counts, or explanations through the new scoring logic; targeted side-channel tests are also required.

### 12.5 Text coverage is a separate requirement

The graph cannot recover a term that the lexical index never retained unless another path happens to lead to the right note. That is opportunistic recovery, not full-text coverage.

Evaluate full-note, chunked indexing as the necessary companion work for potential D1 retirement. Chunk by supported structural/message boundaries and bounded size; map every chunk to its parent note for authorization; allow chunks from a large note to span storage partitions rather than requiring the entire note's index to fit in one shard. A chunk identifier is a derivative locator, not a stable note ID.

A query deduplicates chunks to note-level results, preserves useful fragment/excerpt locations, and does not inflate “matching notes” with chunk counts. Limits, unsupported formats, and dropped content must remain explicit. A one-read response saying “index missing” does not count as a fast successful search in benchmarks.

Do not lift the 2,048-character cap without changing the memory/storage design and measuring the consequences. The initial graph can ship independently; the unified-search replacement cannot claim parity on long notes until this coverage gap is closed or an explicitly accepted scope says otherwise.

### 12.6 Publication integrity for the text index

The current v2 contract describes mutable shard writes followed by conditional manifest publication: shard writes are unconditional, and the manifest write is the only concurrency point (`apps/mcp/src/search/CONTRACT.md`). That ordering alone is not proof that concurrent writers cannot leave a shard's bytes inconsistent with the manifest's routing filter. A Bloom filter is recall-safe only for the exact content it describes. [R6]

Before relying on routing to exclude a shard in the replacement design, prove generation coherence under concurrent publication. A minimal solution is writing a new shard revision, referencing its exact key/digest in the conditionally published manifest, and retaining old revisions for in-flight readers. Another mechanism must prove the same invariant. Do not treat a conditional manifest write as a transaction covering previously overwritten objects.

This is a correctness gate for reused infrastructure, not a claim that the existing implementation has already been repaired or an instruction to build an LSM system.

## 13. Agent-authored contextual links

Moved to [AGENT-LINKS.md](./AGENT-LINKS.md), with its subsection numbers unchanged.

## 14. User and tool surfaces

The note view presents authored references/backlinks and derived relatedness without pretending they are one kind of fact. A compact related-notes area at the side or bottom is appropriate; exact placement remains a UI implementation decision. Show the reason where useful: explicitly linked, links here, cites the same note, cites the same URL, or related text.

The graph visualization is optional navigation over the same authorized data. It must be bounded/paginated and must not require downloading the entire private workspace graph to a team reader. A blank/loading/partial graph is not rendered as a confidently empty workspace.

Existing search and fetch/read interfaces receive graph value automatically where compatible. Preserve the exact schemas of foreign-contract tools such as `search(query)` and `fetch(id)`; add metadata only inside supported result surfaces. Do not add a required graph tool, rename an existing compatibility tool, or put unsupported addressing arguments into it. [R10]

`related_notes` may expose focused exploration to clients that support it. It is a convenience over the shared engine, not the only way agents discover relationships. Low-level adjacency/SQL/matrix tools are unnecessary for v1.

Broken-link diagnostics live where a person can act on the affected note. Avoid a permanent count of “problems” computed from private or unobserved data. Repair suggestions distinguish missing, ambiguous, unsupported, and not-yet-checked conditions only to the extent the caller is entitled to know them. Unknown targets do not make ordinary user-authored Markdown unsavable.

## 15. Caching, offline behavior, and security

### 15.1 Runtime acceleration

Use object storage for persistence and a bounded runtime cache for repeated reads. Cache raw derivative records only under workspace, binding epoch, format/generation, object key, and validated version. Cache any **ranked or authorization-dependent result** additionally under its full authorization/privacy fingerprint, or do not cache it across calls.

No decrypted storage credential survives its request. A cache hit never bypasses fresh grant/membership resolution or current privacy checks. A binding change, sign-out, revoked scope, or unknown authorization state cannot fall back to a wider cached result. No shared CDN caches personalized graph responses. [R2]

Mutable node records need version/age validation. Immutable generation/page revisions can be cached by their exact key/digest; manifests and privacy policy have separate freshness requirements. Cloudflare explicitly notes that cached custom-domain responses do not retain the direct R2 API's consistency guarantees. [E8]

Cold-cache performance is part of the product. A process-local cache cannot be assumed warm across Worker isolates or deployments, and the design does not require a new always-on server merely to keep it warm.

### 15.2 Offline

Preserve the existing mirror and outbox. A device may compute local relationships from the permitted copies it actually has, labeling them as local/possibly partial, but that is an optional extension rather than a new promise that all graph features work offline immediately.

Do not download the owner-wide `.context/graph/` into a team device. Reuse the filtered mirror or an equally filtered derivative. An offline queued rename is not an authoritative bucket move and must not update the canonical graph until it lands. Graph invalidation follows the committed result of queue replay, including conflicts and path changes.

Unsent drafts and queued writes are not caches and are never swept as graph garbage. A live collaborative document may contain unsaved keystrokes; index its committed bucket checkpoint, not transient text as if it were already durable. Existing refusal-over-cache, session-epoch, and conflict rules remain intact. [R8]

### 15.3 Untrusted data and observability

All bucket data, including `.context/` JSON, is untrusted input. Validate paths, formats, counts, nesting, and byte sizes before allocating or following references. Use safe map/pair representations for attacker-controlled keys. A forged reverse posting must never become authority to read an otherwise forbidden source or rewrite a note.

Canonical repair re-reads and re-parses the source under current authority. Network egress to cited URLs is absent. Unsupported executable schemes are never turned into actions. A candidate excerpt is quoted evidence, not an instruction to the agent.

Operational telemetry records aggregate latency, bytes, operation counts, cache outcomes, projection lag, failure classes, and repair progress where permitted. It does not export note text, search text, URLs, graph edges, titles, or content-derived fingerprints into platform analytics. Detailed note-specific repair data stays in the customer's bucket and is exposed through the existing authorization model.

No user corpus is sent to an evaluation model or third-party benchmark service without a separate explicit authorization. Public repository fixtures use synthetic or approved public content only.

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
