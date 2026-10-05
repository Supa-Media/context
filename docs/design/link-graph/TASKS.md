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
