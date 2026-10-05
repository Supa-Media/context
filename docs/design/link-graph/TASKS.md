# Link graph: task breakdown for execution

Task-sized steps for [PLAN.md](./PLAN.md), executed one implementer per task with a review after each. PLAN.md and [README.md](./README.md) (the architecture) are the authority; this file only cuts them into tasks. Tasks for later phases are added when the phase before them is reviewed.

## Global constraints (every task)

- Test first: write the failing test, watch it fail, then write the code. Sabotage each new guard once (break it, confirm the named test fails, restore) and record it in the test file's "Sabotage record" comment, the way existing tests in `apps/mcp/test/` do.
- `apps/mcp/src` stays dependency-free: relative imports only, Web APIs only, no `node:` imports (`node scripts/check-gateway-imports.mjs`).
- No handwritten file over 1,000 lines; `pnpm architecture` must report 0 errors.
- `pnpm --filter @context/mcp test` must stay green and must not lose checks. The suite prints `ALL PASS` and node:test totals; report both.
- No em-dashes in new prose or comments. Fixtures use fake values only.
- Commit messages say why. No Co-Authored-By or other attribution lines.
- Never use `rm`; use `trash`.

## Task 0: Phase 0 review only

Already implemented in commit 686c9bbd (`apps/mcp/bench/`, `apps/mcp/test/benchHarness.test.mjs`, `docs/design/link-graph/BASELINE.md`, the AGENT-LINKS.md split). Review against PLAN.md Phase 0.

## Task 1: `extractReferences` and `resolveReference` in the gateway

**File:** `apps/mcp/src/links.js` (393 lines today), tests in `apps/mcp/test/links.test.mjs` (or a new `apps/mcp/test/linkReferences.test.mjs` added to the `test` script in `apps/mcp/package.json` if `links.test.mjs` would pass 1,000 lines).

**Data model.**

- Occurrence: `{ kind: "wiki" | "inline", embed: boolean, target: string, start: number, end: number, fragment: string, style: "relative" | "rooted" | "bare" | null }`. `kind`, `embed`, `target`, `start`, `end` are exactly what `parseLinks` returns today. `fragment` is the anchor including its `#` (`"#heading"`, `"#^block"`) or `""`. `style` is `styleOf` of the file part after the same decoding `resolveLink` applies, or `null` when the target is external, empty or anchor-only.
- Reference-style definitions (`[label]: target` on their own line, outside code) are reported as occurrences with `kind: "definition"` so a caller can see they exist; their span is the target.
- Resolution: `{ state: "resolved" | "missing" | "ambiguous" | "unknown" | "invalid" | "unsupported" | "external", path?: string }`. `path` is present only for `resolved`.

**API.**

- `extractReferences(text)`: every occurrence in the whole text, in document order, code spans and fences ignored (reuse `codeRanges`), no length cap. Built on `parseLinks`, not a second parser.
- `resolveReference(occurrence, fromPath, catalog)`: `catalog` is `{ byName: Map<string, string[]>, paths?: Set<string> }` (`byName` as `indexByName` builds it). Rules:
  - external target (scheme or `//`): `external`.
  - `definition` kind: `unsupported`.
  - empty or anchor-only target: `invalid`.
  - relative or rooted path that escapes the root (`normalizeSegments` returns null) or normalizes to nothing: `invalid`.
  - relative or rooted path: the same path `resolveLink` computes; `resolved` if `catalog.paths` is given and has it, `missing` if `catalog.paths` is given and lacks it, `unknown` if `catalog.paths` is absent.
  - bare name: exactly one candidate in `byName` is `resolved` with that path; more than one is `ambiguous`; none is `missing` when `catalog.paths` is given, `unknown` when it is not.
- `resolveLink` keeps its current behavior and signature; existing tests in `apps/mcp/test/links.test.mjs` pass unchanged.

**Tests (write first).** A shared fixture table exported from a new `apps/mcp/test/fixtures/linkReferences.mjs` (plain data: `{ name, text, fromPath, catalog, expected }`) that Task 3 reuses for parity. Cases: wiki, alias, embed, inline with title, angle-bracketed target, percent-encoded space, anchor and block anchor, a link past 2,048 characters, links inside inline code and inside a fenced block (ignored), an unterminated fence, a reference definition (`unsupported`), a URL and a `mailto:` (`external`), `../` escaping the root (`invalid`), an anchor-only link (`invalid`), a bare name with one, two and zero candidates, and relative/rooted targets with and without `catalog.paths`.

## Task 2: the search indexer uses the shared reader

**File:** `apps/mcp/src/search/indexer.js`; tests in the existing search tests under `apps/mcp/test/` that cover `extractFields` / doc `links`.

- Delete `WIKILINK_RE`, `MDLINK_RE` and the regex loop in `extractLinks`; build the list from `extractReferences(text)` instead, so links inside code no longer count and links anywhere in the body (no cap) count.
- **Ruling (controller): keep today's resolution semantics for the stored `links` field.** A bare wiki target still resolves relative to the note's folder with `.md` appended (today's `extractLinks` behavior), because the v1 index's PageRank reads this field and changing what it points at is a ranking change Phase 1 does not make. Relative and rooted targets resolve exactly as today's local `resolveLink` in indexer.js does (only `.md` results kept, root escape dropped). The stored value stays `string[]`, deduplicated, order preserved.
- Test first: a note with a `[[link]]` inside a fenced block and inside inline code no longer contributes those links; a note whose link sits past 2,048 characters still contributes it; existing indexer tests pass unchanged. Sabotage: restore the old regex loop and the code-span test fails.

## Task 3: the app's copy and the parity test

**Files:** `packages/shared/src/links.ts` (407 lines), `apps/convex/__tests__/linkParity.test.ts`.

- Port `extractReferences` and `resolveReference` with TypeScript types (`LinkOccurrence`, `LinkResolution`, `LinkCatalog`) matching Task 1's data model exactly.
- Extend `linkParity.test.ts` so the gateway and shared copies return identical results over Task 1's fixture table (import it from `../../mcp/test/fixtures/linkReferences.mjs`) and over the existing parity corpus.
- Run with `pnpm --filter @context/convex test -- linkParity` (check the package's actual name and script in `apps/convex/package.json` first). Sabotage: change one rule in one copy only and the parity test fails.

## Phase 2 tasks

Drafted from PLAN.md Phase 2 and the architecture; every point the sources left open is settled below as a controller ruling (marked with its OPEN number), which the owner can reverse at review.

### Phase 2 global constraints (in addition to the ones above)

## Global constraints (every task)

All of TASKS.md "Global constraints" apply unchanged (test first, sabotage record, no `node:` imports in `apps/mcp/src`, no handwritten file over 1,000 lines, `pnpm architecture` 0 errors, `pnpm --filter @context/mcp test` green with `ALL PASS` and node:test totals reported, no em-dashes, fake fixture values, no attribution lines, `trash` not `rm`). In addition, for Phase 2:

- **The graph is a derivative and never fails a write** (arch 6.1, D03). Every graph call reachable from a write or a search is behind the response or inside a try/catch that swallows into "pending"; no graph exception reaches a tool result.
- **No new runtime dependency** (P10). SHA-256 is `crypto.subtle.digest`. Reuse an existing `sha256Hex` (identical copies exist in `apps/mcp/src/ingestion/inbox.js:63` and `apps/mcp/src/controlPlane/client.js:50`); import one of those rather than writing a fifth copy. Ruling (controller, OPEN-1): which one to import. Recommend `ingestion/inbox.js` (no control-plane coupling); if `pnpm architecture` flags the cross-module import, move nothing and ask the controller. Cost if wrong: one import line changes.
- **Every store op goes through a budget** shaped like `createSearchBudget` (`apps/mcp/src/search/maintain.js:212`, `take(reserve)` / `remaining` / `spent`). Graph modules take the budget object; they never construct an unbounded one.
- **Keys are plumbing.** Everything lives under `.context/graph/`, which `isPlumbing` and `defaultIsIndexable` already hide because of the dot segment (`maintain.js:276`). No new visibility rule is added; Task 4 asserts the existing one covers the new prefix.
- **Privacy.** Graph objects are workspace-wide, written with the indexer's scope like `.context/search/` (arch 10.4, 11.1). Nothing a graph module returns to a caller is computed before the caller's `canSee` filter (arch 2.3). No counts over the whole workspace leave the gateway (arch 7.3, `shards/sync.js` "the census is owner-only").
- **Encrypted notes contribute nothing** (arch 7.6): decided with `isEncryptedNote` from `apps/mcp/src/encryption.js` on the stored body, the same marker check `write.js` uses.
- New test files are node:test style (like `test/linkReferences.test.mjs`) and are added to the `test` script in `apps/mcp/package.json`.
- Test store: `memoryBucket` in `apps/mcp/test/store/fixtures.mjs:94` models conditional puts (`etagMatches`) and the B2/Wasabi failure (`ignoreIfMatch`). As read, its `put` does not honour `onlyIf: { absent: true }`. The first task that needs conditional create (Task 6) extends the fixture: `absent: true` refuses an existing key, and `ignoreIfMatch: true` ignores `absent` too (B2 behaviour). Existing fixture users must stay green.


### Phase 2 decision table

| Choice | Answer | Source |
|---|---|---|
| Layout under `.context/graph/v1/` | `manifest.json`; `g/<gen>/nodes/<path-hash>.json`; `g/<gen>/incoming/<target-hash>/`, `bare/<name-hash>/`, `names/<name-hash>/`, `urls/<url-hash>/`, `maintenance/` | arch 9.1, PLAN Phase 2 |
| Node locator | SHA-256 hex of the UTF-8 logical path; record stores the path and the reader validates it | arch 9.1 |
| Posting page shape | `{ key, entries: [{ source, referenceSetVersion }], next? }`, page size constant, initial 256 entries | PLAN Phase 2 |
| Generation value format | OPEN-2 (Task 4) | arch 9.1 says only "generation" |
| Page key naming inside a posting directory | OPEN-3 (Task 4) | arch 9.1: "small directory and bounded pages" |
| URL comparison key rules | Conservative, versioned; scheme/host case and explicit default port only; credential/userinfo/signed URLs excluded | arch 8.2; exact detector list OPEN-6 |
| Which targets get `incoming/` | OPEN-5 (Task 5) | arch 7.2 says a non-Markdown path is not automatically a note vertex |
| Forward record size limit | OPEN-7 (Task 5) | arch 9.2: overflow pages or explicit partial coverage |
| `referenceSetVersion` derivation | OPEN-8 (Task 5) | arch 9.2: identifies the normalized reference set |
| Conflict retry bound on posting pages | OPEN-9 (Task 6) | arch 9.3: "bounded conflict budgets" |
| P4 mode selection | OPEN-10 (Task 6) | P4, arch 6.2 (create/update/delete are separate capabilities) |
| Behaviour on stores without conditional writes | Best effort on every write, unconditional puts, answers labelled possibly incomplete; moves never rely on the index there (Phase 3) | P4, arch 9.5 |
| Inline graph work on write, budgeted | One budget object per write sized by `WRITE_ENRICH_SUBREQUEST_BUDGET` (default 8, hosted 80, clamped like the search budget); forward record first, then reverse keys; leftover recorded in `reverseRepair`; never limits the write | P5, arch 16.3, 9.4 |
| Inline vs deferred | OPEN-12 (Task 8) | arch 13.5 vs 16.3 |
| Clamp bounds for the write budget | OPEN-11 (Task 8) | P5 says "clamped like `SEARCH_SUBREQUEST_BUDGET`" without values |
| Generation switching | Build fresh, publish only after coverage and reverse checks pass, readers pin per request, writers to the old generation trigger repair of the new one | arch 9.6; mechanism OPEN-16 (Task 11) |
| What `graphHealth` returns | OPEN-13 (Task 9) | arch 6.4 gives the states `ready`, `behind`, `unavailable`, `partial` |
| Census source for reconciliation | The search index's docmap via `censusFromManifest` / `loadCensus` (`search/d1/backfill.js:185`, `:215`), the same census the D1 projection uses | arch 10.1, D21 |
| Sharing fetched bodies with the search sync | OPEN-14 (Task 10) | arch 10.1 says a body fetched once "can" feed both |
| Deletion detection | OPEN-15 (Task 10) | arch 10.3: never infer deletion from an incomplete listing |
| Where O1 is recorded | OPEN-17 (Task 12) | PLAN "Across every phase", O1 |

## Task 4: graph prefix, keys and record codecs

**Files:** `packages/shared/src/storageLayout.cjs` (65 lines; add `GRAPH_PREFIX`), `apps/mcp/src/graph/keys.js` (new), `apps/mcp/src/graph/records.js` (new), tests `apps/mcp/test/graphRecords.test.mjs` (new).

**Data model.**

- `GRAPH_PREFIX = ".context/graph/"` beside `SEARCH_PREFIX`, exported. Not added to `LEGACY_STORAGE_PREFIXES` (no legacy location; same treatment as `ORGANIZER_PREFIX`).
- `GRAPH_FORMAT_VERSION = 1`; manifest key `${GRAPH_PREFIX}v1/manifest.json`.
- Manifest: `{ formatVersion: 1, generation: string, building: null | { generation: string, startedAt: string }, mode: "conditional" | "best-effort", health: { state: "ready" | "behind" | "unavailable" | "partial", sweepComplete: boolean, lastSweepAt: string | null, parserVersion: number, resolverVersion: number, urlKeyVersion: number } }`. The `health` fields beyond `state` are OPEN-13's recommendation; Task 9 owns their semantics.
- Node record (arch 9.2): `{ formatVersion, path, observedSourceVersion, observedAt, parserVersion, resolverVersion, urlKeyVersion, referenceSetVersion, occurrences: [{ kind, target, start, end, fragment, style }], externalReferences: [{ urlHash, start, end }], coverage: "complete" | "partial" | "unsupported" | "excluded", reverseRepair: [postingRef] }` where `postingRef` is `{ family: "incoming" | "bare" | "names" | "urls", hash }`. `resolutionHints` from arch 9.2 is omitted in Phase 2 (nothing reads it until Phase 3); Ruling (controller, OPEN-4): confirm omission. Cost if wrong: Phase 3 adds an optional field, no format bump needed if readers ignore unknown fields.
- Posting page: `{ key, entries: [{ source, referenceSetVersion }], next?: string }`, `POSTING_PAGE_SIZE = 256`.

**API.**

- `keys.js`: `graphManifestKey()`, `nodeKey(gen, pathHash)`, `postingPageKey(gen, family, hash, page)`, `async pathHash(path)`, `async nameHash(name)`, `async urlHash(urlKey)`; all hashes `sha256Hex` of UTF-8.
- Ruling (controller, OPEN-2): generation format. Recommend a decimal counter string (`"1"`, `"2"`), new = active + 1, compared only for equality. Cost if wrong: a rename of the key segment, graph rebuilds (disposable).
- Ruling (controller, OPEN-3): page keys. Recommend `<family>/<hash>/0.json` as the head page and `next` naming the next page's number; a missing head means an empty list. Cost if wrong: format bump plus rebuild.
- `records.js`: `parseManifest(text)`, `parseNode(text, expectedPath)`, `parsePage(text, expectedKey)`, `serialize*` for each. Parsers return `null` (never throw) on bad JSON, unknown or newer `formatVersion` (arch 9.6: never parse a newer format optimistically), a `path`/`key` that does not match the expected one (arch 9.1), or a body over a byte cap. Byte cap: OPEN-7 shares the value with Task 5. Reuse `exceedsUtf8Bytes` (`search/maintain.js:185`) for the cap.

**Tests (write first).** Round trip of each record; each `null` case (bad JSON, newer format, mismatched path, mismatched page key, over cap); `pathHash` deterministic and case-sensitive (`A.md` vs `a.md` differ, arch 7.2 "case-sensitive logical keys"); a real gateway helper (`isPlumbing` from `apps/mcp/src/privacy/engine.js` and `defaultIsIndexable`) treats every key `keys.js` produces as plumbing. Sabotage: drop the path check in `parseNode` and the mismatched-path test fails; let `parseManifest` accept `formatVersion: 2` and the newer-format test fails.

## Task 5: pure forward-record builder

**Files:** `apps/mcp/src/graph/facts.js` (new), `apps/mcp/src/graph/urlKey.js` (new), tests `apps/mcp/test/graphFacts.test.mjs` (new).

**Data model.** Task 4's node record. A reverse membership set: `Set` of `postingRef` strings `"<family>:<hash>"`.

**API.**

- `async buildNodeRecord(path, body, version, { now })` returns `{ record, memberships }`. Pure apart from hashing. Uses `extractReferences(body)` (Phase 1, `links.js:289`) on the full body, no cap (arch 7.1).
  - Encrypted body (`isEncryptedNote`): `coverage: "excluded"`, empty occurrences and URLs, and an empty membership set (not even `names/`). Ruling (controller, OPEN-18): whether an encrypted note stays in `names/` for bare-name lookup. Recommend excluded entirely (arch 7.6 "no hidden contents are inferred"; its basename is a path, not contents, but keeping it is a separate decision). Cost if wrong: bare links to encrypted notes show `missing` instead of `resolved` until a format bump.
  - `incoming/`: for each occurrence whose `style` is `relative` or `rooted`, the path `resolveLink` (`links.js:231`) computes with an empty `byName`; root escape and anchor-only produce nothing. Ruling (controller, OPEN-5): only `.md` targets get `incoming/` (mirrors the Task 2 ruling for the search `links` field). Cost if wrong: attachment backlinks need a format bump and rebuild.
  - `bare/`: for each `bare` occurrence, the name `resolveReference` would look up in `byName` (same basename rule as `indexByName`, `links.js:469`). The written bare target is stored in `occurrences` (arch 7.4: persist the original bare target).
  - `names/`: the note's own basename, exactly as `indexByName` computes it.
  - `urls/`: each `external` occurrence with an `http`/`https` target through `urlKey`; excluded keys contribute nothing.
  - `definition` occurrences are kept in `occurrences` and contribute no membership (`unsupported`, arch 7.1).
  - Adjacency is deduplicated by membership; occurrences keep every span (arch 7.1, 8.4).
- `urlKey(raw)` returns `{ key, version } | null`. Rules from arch 8.2: parse with `URL`; lowercase scheme and host; drop an explicit default port; preserve path case, query order, fragment. `null` for userinfo-bearing URLs and for URLs the detector recognizes as credentials, bearer/share tokens or signed downloads. Ruling (controller, OPEN-6): the detector list. Recommend: userinfo present, or a query parameter name matching a small fixed list (for example `token`, `access_token`, `signature`, `X-Amz-Signature`, `sig`, `key`); record the list in the module comment as "heuristic, not a guarantee" (arch 8.2). Cost if wrong: a secret-bearing URL groups notes in `urls/` (private derivative, never telemetry) until the list grows; changing the list bumps `urlKeyVersion`.
- Ruling (controller, OPEN-7): forward record size limit. Recommend a byte cap on the serialized node of 256 KiB (a starting value to be measured on a managed bucket per arch 9.1) and, when exceeded, keep occurrences in document order up to the cap and set `coverage: "partial"`; memberships still computed from all occurrences so reverse postings stay complete. Cost if wrong: a very link-dense note reports partial and Phase 3 falls back to scan for moves touching it.
- Ruling (controller, OPEN-8): `referenceSetVersion` = `sha256Hex` of the sorted membership strings joined with `\n`, prefixed by `parserVersion`, `resolverVersion`, `urlKeyVersion`. Arch 9.2: prose-only edits leave it unchanged; resolver or URL-rule changes change it intentionally. Cost if wrong: unnecessary reverse rewrites (too sensitive) or missed ones (too coarse, caught by reconciliation audit).

**Tests (write first).** Reuse `apps/mcp/test/fixtures/linkReferences.mjs` bodies where they fit. Cases: prose edit leaves `referenceSetVersion` unchanged; adding a link changes it; a link past 2,048 characters is a membership; links in code are not; reference definition kept, no membership; `../` escape yields nothing; bare name goes to `bare/` and keeps its written target; non-`.md` relative target excluded (per OPEN-5); duplicate links to one target are one membership and two occurrences; encrypted body yields `excluded` and empty memberships; `urlKey` keeps path case and query order, lowercases host, drops `:443` on https, returns `null` for `https://user:pw@host/` and for a `?token=` URL; over-cap record is `partial` with full memberships. Sabotage: skip the encryption check and the encrypted test fails; dedupe occurrences instead of memberships and the duplicate test fails.

## Task 6: posting pages and the P4 mode

**Files:** `apps/mcp/src/graph/postings.js` (new), `apps/mcp/src/graph/mode.js` (new), `apps/mcp/test/store/fixtures.mjs` (extend `memoryBucket` for `absent`, see Global constraints), tests `apps/mcp/test/graphPostings.test.mjs` (new).

**Data model.** Task 4's posting page. `mode` is `"conditional" | "best-effort"`.

**API.**

- `graphMode(store)`. Ruling (controller, OPEN-10): `"conditional"` only when `store.capabilities.conditionalWrite === true && store.capabilities.conditionalCreate === true` (the probed flags documented at `apps/mcp/src/controlPlane.js:282`; same pairing `storageLayout.js:365` requires); otherwise `"best-effort"`. Deletes are never needed: an emptied page is written as `entries: []`. Cost if wrong: a store with only one of the two flags runs best effort and is labelled possibly incomplete.
- `async setMembership(store, budget, { gen, family, hash, source, referenceSetVersion, present, mode })` returns `"done" | "conflict" | "budget"`. Walks the page chain from the head, removes every entry for `source`, and if `present` adds `{ source, referenceSetVersion }` to the first page with room, appending a new page (and linking `next`) when all are full. Each page write is `onlyIf: { etagMatches }` (existing page) or `{ absent: true }` (new page) in conditional mode, unconditional in best-effort mode. On a refused conditional write: re-read, re-merge, retry up to OPEN-9 times, then return `"conflict"`. Never replaces a page from an old snapshot (arch 9.3). Any op the budget refuses returns `"budget"` without a partial write being described as done.
- Ruling (controller, OPEN-9): retry bound. Recommend 3, the attempt count `projectWrittenNoteAfterResponse` already uses (`search/writeProjection.js`). Cost if wrong: more `"conflict"` results left to reconciliation, or more ops spent under contention.
- `async readPostings(store, budget, { gen, family, hash, canSee, validate })` returns `{ entries: [{ source, referenceSetVersion }], complete: boolean }`. Applies `canSee(source)` to each entry before anything is collected or counted, then `validate(entry)` (Task 7 supplies one that reads the source node and compares `referenceSetVersion`, arch 9.3); invalid or unverified entries are dropped. `complete` is false when the budget ran out mid-chain. This is the reader Phase 3 consumes.

**Tests (write first).** On `memoryBucket()`: two writers adding different sources to the same head page concurrently (interleave via a wrapped `put`) both survive; add, re-add with a new `referenceSetVersion` (one entry, updated), remove; overflow past 256 creates and links page 1; removal from page 1 works; exhausted budget returns `"budget"` and leaves pages parseable; conditional refusal past the retry bound returns `"conflict"`. On `memoryBucket({ ignoreIfMatch: true })`: `graphMode` with capabilities false is `"best-effort"` and writes go through. `readPostings`: a source `canSee` rejects never appears and the visible result is identical with and without the hidden entry present; a stale `referenceSetVersion` is dropped by `validate`. Sabotage: write pages unconditionally in conditional mode and the concurrent-writer test fails; apply `canSee` after `validate` collects counts (or not at all) and the privacy test fails.

## Task 7: `projectNote` (forward publish plus reverse repair)

**Files:** `apps/mcp/src/graph/project.js` (new), tests `apps/mcp/test/graphProject.test.mjs` (new).

**API.** `async projectNote(store, path, body, version, { budget, gen, mode, now })` returns `{ state: "projected" | "pending" | "skipped" | "stale" }`. Implements arch 9.4 in order:

1. Read the existing node record (its etag is the expected revision) before using `body`/`version` (arch 9.4 last paragraph). If the stored record's `observedSourceVersion` equals `version` and `reverseRepair` is empty, return `"skipped"` (no write for an unchanged source).
2. `buildNodeRecord` (Task 5). `reverseRepair` = union of old memberships, new memberships, and the old record's outstanding `reverseRepair` (a newer edit merges outstanding cleanup, never erases it).
3. Publish the node record with `reverseRepair` set, conditional on step 1's etag (or `absent`) in conditional mode. On refusal return `"stale"`; the caller (write path or reconciliation) does not retry with the same body (arch 9.4: re-read the source too).
4. For each `reverseRepair` entry, `setMembership` with `present` = "is it in the new memberships", stopping when the budget refuses.
5. If every entry finished, clear `reverseRepair` with a conditional write that still names the same `observedSourceVersion` and `referenceSetVersion`; return `"projected"`. Otherwise publish nothing more and return `"pending"` (the record already carries the outstanding work).

If `reverseRepair` would exceed the record cap (OPEN-7), mark the node `coverage: "partial"` and leave a rebuild hint in the manifest health via Task 9 rather than dropping obligations (arch 9.4). `removeNote(store, path, { budget, gen, mode })`: the same procedure with an empty new membership set, then the node record is removed: `store.delete` when `conditionalDelete` is true, otherwise an overwrite with `coverage: "excluded"` and no memberships (OPEN-15 decides when `removeNote` is called).

Also exports `validateEntry(store, budget, gen)` for `readPostings`: reads the source node, accepts the entry only when the node parses for that path, has no conflicting `referenceSetVersion`, and its `coverage` is not `excluded`.

**Tests (write first).** Concurrent `projectNote` for two sources linking one target on a conditional store: both memberships present after both settle. A source edit that removes a link removes its membership. Interrupted cleanup: budget runs out after the node publish; a second call with the same body and version (no new note edit) finishes the repair and clears `reverseRepair` (arch 18.1 "interrupted cleanup is discoverable without a new note edit"). An older delayed membership write is rejected by `validateEntry` after a newer projection. Edit-to-encrypted removes every prior membership. Unchanged source is `"skipped"` with exactly one store op spent (assert `budget.spent`). Sabotage: clear `reverseRepair` without the version condition and the interrupted-cleanup test fails; drop the merge of old `reverseRepair` and a two-edit sequence leaves a stale membership.

## Task 8: write budget and the post-commit hook

**Files:** `apps/mcp/src/search/budget.js` (79 lines; add `writeEnrichBudgetFor`), `apps/mcp/src/http/route.js` (559 lines; set `store.writeEnrichBudget` beside `store.searchSubrequestBudget` at line 257), `apps/mcp/src/graph/afterWrite.js` (new), `apps/mcp/src/tools/notes/write.js` (481 lines; one call after `projectWrittenNoteAfterResponse`), `apps/mcp/wrangler.toml` (229 lines), tests `apps/mcp/test/graphWrite.test.mjs` (new).

**Data model.** `WRITE_ENRICH_SUBREQUEST_BUDGET`: default 8 storage requests, 80 on the hosted deployment (P5). Hosted value goes in `[vars]` beside `SEARCH_SUBREQUEST_BUDGET = "600"` (line 84). Ruling (controller, OPEN-19): also set it in `[env.staging.vars]` (line 212), mirroring how the search budget is set there. Cost if wrong: staging measures a different budget than production.

**API.**

- `writeEnrichBudgetFor(env)` like `searchBudgetFor`: unparseable means the default, never a throw. Ruling (controller, OPEN-11): clamp bounds. Recommend floor 0 (a deployment may turn inline graph work off) and cap 900 (the search cap, leaving the rest of the invocation under the paid limit). Cost if wrong: a misconfigured var spends more of the write's invocation than intended, or cannot disable the work.
- `projectNoteAfterWrite(store, { path, body, version, budget })` in `afterWrite.js`: reads and parses the graph manifest (1 op, pins the generation for this write), returns without work when there is no manifest (reconciliation creates it, Task 10), otherwise calls `projectNote`. Never rejects; a `"pending"` or `"stale"` result is left to reconciliation (arch 16.3).
- `toolWriteNote` creates the budget object once, `createSearchBudget(store.writeEnrichBudget ?? <default>)`, and passes it. Phase 4 will spend suggestions from the same object first; this task leaves that seam as the single budget variable and adds no suggestion code. `body` is the stored body (`collaborationResult.text` when merged, the sealed envelope when encrypted), so the graph sees committed text (AGENT-LINKS 13.4) and encrypted notes are excluded by Task 5.
- Ruling (controller, OPEN-12): inline or deferred. Recommend deferred behind the response with the `afterResponse` pattern in `search/writeProjection.js` (inline only where `store.defer` is absent), spending the same per-write budget object. Arch 13.5 allows durable maintenance after the response; arch 16.3 says `waitUntil` spends the same subrequest counter, which the per-write budget already caps. Cost if wrong: if the owner wants graph state current before the response returns, a write's latency rises by the graph ops.
- Applies to every caller of `toolWriteNote` (`write_note`, `remember`, comments, forms), because each is a Context-managed write whose committed path, body and version are change hints (arch 10.1). Moves and archive do not call it and are left to reconciliation (they go through `recordChange`, which has no body). Ruling (controller, OPEN-20): confirm moves/archive are left to reconciliation in Phase 2. Cost if wrong: stale node records at old paths until the next pass (rejected by `validateEntry`, and Phase 3 moves fall back to scan when coverage is not complete).

**Tests (write first).** Through the real `toolWriteNote` (harness store): a write with budget 0 succeeds and returns byte-identical text to today's (graph skipped); a write with the default 8 publishes the node record; a write whose note has many new links publishes the node with `reverseRepair` non-empty and the write result is unchanged; a graph store failure (wrapped `put` throwing on `.context/graph/`) does not change the write result; `remember` writes also project; `writeEnrichBudgetFor` parsing (absent, `"80"`, `"abc"`, negative, huge); assert total graph ops never exceed the budget. Sabotage: let the hook throw and the failure test fails; ignore the budget and the op-count test fails.

## Task 9: manifest lifecycle and `graphHealth`

**Files:** `apps/mcp/src/graph/manifest.js` (new), tests `apps/mcp/test/graphManifest.test.mjs` (new).

**API.**

- `async loadGraphManifest(store, budget)` returns the parsed manifest or `null`.
- `async initGraphManifest(store, budget, { mode, now })`: conditional create (`absent`) of generation `"1"` with `health.state: "partial"`, `sweepComplete: false`; on a store in best-effort mode, an unconditional put after a read finds none.
- `async publishHealth(store, budget, manifest, etag, patch)`: conditional update; a refused write is dropped (the next pass recomputes). The manifest changes for health and generation only, never per edit (arch 9.1).
- `async graphHealth(store, budget)`. Ruling (controller, OPEN-13): returns `{ state: "ready" | "behind" | "unavailable" | "partial", generation: string | null, mode, possiblyIncomplete: boolean, complete: boolean }`. `unavailable` when there is no manifest or it does not parse (including a newer format, arch 9.6). `possiblyIncomplete` is true whenever `mode` is `"best-effort"` (P4) or `state` is not `ready`. `complete` is true only when `mode === "conditional"`, `state === "ready"`, `sweepComplete` and no rebuild hint is set; it is the flag Phase 3 moves read to decide index versus scan. No counts are returned (arch 7.3). Cost if wrong: Phase 3 needs an extra field; the format is internal so no migration.

**Tests (write first).** No manifest is `unavailable`; init twice concurrently leaves one manifest; best-effort store always reports `possiblyIncomplete: true` and `complete: false` even after a complete sweep (P4 labelling); a newer `formatVersion` is `unavailable` and is not overwritten by `publishHealth` (arch 9.6: an older client must not clear state it does not understand). Sabotage: report `complete` without checking `mode` and the B2-labelling test fails.

## Task 10: `reconcileGraph` on the shared census

**Files:** `apps/mcp/src/graph/reconcile.js` (new), `apps/mcp/src/search/maintenance.js` (408 lines; one call after `projectAfterSync` inside `maintainNow`), `apps/mcp/src/search/pacing.js` (108 lines; graph floor constant), tests `apps/mcp/test/graphReconcile.test.mjs` (new).

**Data model.** Cursor object `g/<gen>/maintenance/cursor.json`: `{ sweepCursor: string, sweepStartedAt: string, auditCursor: string }`, written conditionally. Progress is the graph's own, separate from the search manifest and from D1 (arch 10.1: projection progress is not conflated).

**API.** `async reconcileGraph(store, budget, { census, censusComplete, removedHints, isIndexable, now })` returns `{ projected, pending, sweepComplete }` (internal, never printed to a caller).

- Census: `census` is `Map<path, version>` from `censusFromManifest(synced.manifest)` when the sync ran, else `loadCensus(store, budget)` (`search/d1/backfill.js`), exactly as `projectAfterSync` obtains it. `censusComplete` is false when the search manifest's freshness says the listing was truncated. No graph-owned bucket walk (arch 10.1, D21).
- Loads or initializes the manifest (Task 9), pins its generation, walks census paths in sorted order from `sweepCursor`: read the node record; when it is missing, its `observedSourceVersion` differs from the census version, or `reverseRepair` is non-empty, GET the note body and `projectNote`. A full wrap with `censusComplete` sets `sweepComplete` and `lastSweepAt`; `state` becomes `ready` only when the wrap found nothing pending.
- Ruling (controller, OPEN-14): bodies are fetched by the graph pass itself, not shared from `syncShardedIndex`. Recommend this for Phase 2 because `search/shards/sync.js` is 885 lines and threading a callback through its fetch waves risks the 1,000-line cap and couples the two projections' failure handling. Cost if wrong: one extra GET per changed note per pass (measured in Phase 5), and a later task adds an `onFetched` option to the sync.
- Ruling (controller, OPEN-15): deletions. Recommend two sources only: `synced.removed` paths as hints (the sync already decided they are gone) and, on a pass with `censusComplete`, a bounded audit that lists `g/<gen>/nodes/` from `auditCursor` and checks each record's path against the census. A path absent from a complete census is confirmed with a direct GET of the note returning not-found before `removeNote` (arch 10.3: never infer deletion from an incomplete listing, an authoritative per-path not-found may invalidate). Cost if wrong: deleted notes' memberships linger until the audit reaches them (rejected by `validateEntry` meanwhile).
- `maintainNow` wiring: after the existing sync and D1 steps, when a sync ran this invocation (`synced` non-null) and `budget.remaining` is at least `GRAPH_PASS_FLOOR`, call `reconcileGraph` inside its own try/catch. Ruling (controller, OPEN-21): the floor value and whether graph work gets a reserve taken before the sync spends (the `reserve` pattern `maintainNow` uses for D1). Recommend no reserve in Phase 2 (graph takes what search and D1 left) and a floor equal to the ops of one stale note (manifest, node read, body read, node write, two page read/write pairs, clear: 9). Cost if wrong: graph converges slower on free-tier budgets, or starves the search sync.
- Graph progress runs only where search maintenance already runs (searches and writes), the existing authorized scheduling (arch 10.3, 10.4). No new scheduled handler or endpoint.

**Tests (write first).** Lost membership (posting page manually emptied while the node is current) is restored by the audit within a bounded number of passes; interrupted cleanup recovered by reconciliation with no note edit; a truncated census never removes a node; a note deleted from the bucket loses its memberships after an authoritative not-found; a pass never exceeds the budget it was given (assert `spent`); a graph failure inside `maintainNow` does not change the search sync result; encrypted note in the census yields `excluded`. Sabotage: remove nodes on a truncated census and the truncated-census test fails; skip the `reverseRepair` check in the sweep and the interrupted-cleanup test fails.

## Task 11: rebuild generations and cutover

**Files:** `apps/mcp/src/graph/rebuild.js` (new), `apps/mcp/src/graph/reconcile.js` (from Task 10), tests `apps/mcp/test/graphRebuild.test.mjs` (new).

**API.** A rebuild starts when the manifest's `parserVersion`, `resolverVersion` or `urlKeyVersion` differs from the running code, or `formatVersion` is older (arch 9.6). Not when it is newer (fail to `unavailable`).

- `startRebuild`: conditional manifest update setting `building: { generation: active + 1 }`. Reconciliation then sweeps the census into the building generation while writes keep projecting into the active one (readers pin the active generation per request, arch 9.6).
- Ruling (controller, OPEN-16): cutover mechanism. Recommend: cutover only after a building-generation sweep wraps on a complete census with no pending repair, followed by a re-check pass comparing every census version against the building generation's `observedSourceVersion` (re-reading changed sources); then one conditional manifest write swaps `generation` and clears `building`. A write that pinned the old generation before the swap is caught by the new generation's next census diff (its source version differs), which is the "writer targeting the prior generation triggers repair" of arch 9.6. Cost if wrong: an edit made during the build is stale in the new generation for one reconciliation cycle (still rejected by source-version validation in Phase 3 reads).
- Old generation retention and garbage collection (arch 9.6). Ruling (controller, OPEN-22): retention window and deletion. Recommend retaining the previous generation until the next successful cutover (at most one old generation), then deleting `g/<old>/` objects in bounded listing pages from reconciliation, only on stores with `conditionalDelete`, and only under `GRAPH_PREFIX` (arch 2.2: never touch forwarding, assets, audit). Cost if wrong: extra storage for one stale generation, or an in-flight reader of the old generation sees missing pages and reports incomplete.

**Tests (write first).** Rebuild started by a resolver-version bump; an edit made during the build is correct after cutover; cutover does not happen on a truncated census; garbage collection deletes only `g/<old>/` keys and leaves `.context/forwarding.json`, `.context/search/` and the active generation untouched; a newer-format manifest is never cut over or collected. Sabotage: cut over without the re-check pass and the edit-during-build test fails; widen the GC prefix to `GRAPH_PREFIX` and the retention test fails.

## Task 12: record O1 and close Phase 2

**Files:** `docs/decisions/` (OPEN-17), `docs/decisions/README.md` (561 lines; index entry), `apps/mcp/src/forwarding.js` (327 lines; the "It is not a reference index" paragraph at line 25, comment only), no code.

- Ruling (controller, OPEN-17): a new `docs/decisions/link-graph.md` in the existing format (title as a `###` heading, what reversing costs, the test that fails), indexed from `docs/decisions/README.md`, rather than appending to `search.md` (the graph is not the search index). Cost if wrong: one file move and a link fix.
- Content (O1): the reference index is approved; it is a rebuildable derivative under `.context/graph/v1/`; every relationship is validated against the source's current forward record; it is never the authority for a canonical edit; P4 behaviour on stores without conditional writes. "What reversing costs": Phase 3 backlinks, related notes and index-assisted move repair. "The test that fails": the `validateEntry` stale-membership test (Task 7) and the `readPostings` privacy test (Task 6), named by file and check name.
- `forwarding.js` comment: replace the stance with a pointer to the decision; keep the parts that remain true (the ledger records path history only, is not graph-owned, and graph rebuilds never delete it, arch 2.2, 9).
- PR text states what was verified (unit, runtime, live) and what was not (PLAN "Across every phase"). Live measurement on a managed bucket of page and record sizes (arch 9.1) is listed as not done unless the controller schedules it.

**Tests.** None new; the named tests must exist and pass. Reviewer checks the decision cites real test names.

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
