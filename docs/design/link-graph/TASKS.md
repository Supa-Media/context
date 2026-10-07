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
