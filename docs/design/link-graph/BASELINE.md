# Search baseline (Phase 0)

Measured 2026-10-04 on the branch that adds the harness, before any tuning. Re-run with:

```sh
pnpm --filter @context/mcp bench:search -- --sizes 100,1000,10000
```

## Setup

- **Corpus.** `apps/mcp/bench/fixtures.js`, seed 1. A fixed set of 41 judged queries in 8 classes, planted into 100, 1,000 and 10,000 notes. Filler is made-up words no query uses. One note in three is private. The plan's "fixture sets under `apps/mcp/bench/fixtures/` with JSON query sets" is implemented as the deterministic generator `apps/mcp/bench/fixtures.js` (same seed, same corpus), not as committed JSON.
- **B0, bucket search.** The real `syncShardedIndex` and `searchIndexedNotes` (`apps/mcp/src/search/`) against an in-memory bucket. Index built without latency, then searched with 20 ms injected per store operation. Subrequest budget 600 (the hosted value). B0 runs with the production miss refresh (`refreshOnMiss: true`, as in `search/visibleNotes.js`), so an empty answer over a converged index buys a listing and asks again.
- **B5, Fast Search.** The real projection (`search/d1/project.js`, `query.js`, `serve.js`) over `node:sqlite` FTS5 with the production schema, 20 ms injected per D1 request. A private caller, so both tables are queried.
- **Machine.** Node v26.10.0 on macOS. Each engine runs every query twice: cold is the first run, warm the second. Neither engine caches between queries, so cold and warm differ only by JavaScript warm-up. B0 runs before B5 in the same process, so B5's cold run benefits from JIT warmed by B0.
- **Percentiles are coarse.** 41 queries make p95 the second-highest sample and p99 the maximum.
- **Not measured here.** Real R2 and D1 latency. Both 20 ms figures are assumptions. B5 talks to D1 over Cloudflare's HTTP API, which is likely slower than a store read, so the B5 latency numbers below are optimistic for B5.

## Results

### 100 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.66 | 0.68 | 0.73 | 83 / 197 / 199 | 82 / 192 / 200 | 5.39 |
| B5 Fast Search | 0.66 | 0.66 | 0.66 | 22 / 23 / 23 | 22 / 22 / 22 | 2.00 |

### 1,000 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.66 | 0.68 | 0.73 | 86 / 285 / 334 | 87 / 284 / 344 | 6.98 |
| B5 Fast Search | 0.66 | 0.66 | 0.66 | 21 / 22 / 22 | 22 / 22 / 22 | 2.00 |

### 10,000 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.60 | 0.62 | 0.68 | 131 / 812 / 823 | 127 / 811 / 837 | 14.46 |
| B5 Fast Search | 0.66 | 0.66 | 0.66 | 22 / 24 / 24 | 22 / 24 / 25 | 2.00 |

B0 built its 10,000-note index in 19 passes.

### Recall@10 by query class

| Class | What it asks | B0, 1,000 | B5, 1,000 | B0, 10,000 | B5, 10,000 |
|---|---|---|---|---|---|
| exact | a rare term near the top of a note | 1.00 | 1.00 | 1.00 | 1.00 |
| title | a term only in the title | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | a term past 2,048 characters (two past 64,000) | 0.00 | 1.00 | 0.00 | 1.00 |
| multi | two words that meet in one note | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | a word form the note never uses ("deploying" for "deployed") | 0.63 | 0.00 | 0.44 | 0.00 |
| cjk | a word inside unspaced Chinese or Japanese | 0.00 | 0.00 | 0.00 | 0.00 |
| code | the parts of an identifier ("user profile" for `fetchUserProfile`) | 0.75 | 0.50 | 0.50 | 0.50 |
| message | a term in the last message of a long email day | 1.00 | 1.00 | 1.00 | 1.00 |

## What the numbers say

- **Equal headline recall hides opposite gaps.** B0 loses every deep query (the 2,048-character cap); B5 loses every morphology query (FTS5 `unicode61` does no stemming). Neither finds a word inside Chinese or Japanese text, because both treat an unspaced run as one token.
- **B0 degrades with size.** Its morphology and code recall fall from 1,000 to 10,000 notes, and its p95 grows from 285 ms to 812 ms, because a query reads more shards and a miss buys a refresh listing (subrequests rise from 7.0 to 14.5 per query). B5 stays at one request per table.
- **The latency gate is the hard one.** At 10,000 notes B0's p95 is 34 times B5's under equal per-request latency. Tokenizer and chunking work in Phase 5 cannot close that by itself; the gate depends on real D1 latency, which this harness does not have.

## P3 thresholds (recorded before tuning)

A replacement for Fast Search (Phase 6) must meet all of these at 10,000 notes on this corpus and seed:

| Gate | Threshold |
|---|---|
| Recall@10 | at least 0.66 |
| nDCG@10 | at least 0.66 |
| p95 latency, cold and warm | at most 1.5 times B5's, measured in the same run with staging latencies substituted for the 20 ms assumption |
| Platform cost | no increase; subrequests per query reported beside it |

The latency gate is relative, not the 33 ms the table above implies, because both engines' latency is dominated by the injected figure. It is set once staging round trips for R2 reads and D1 HTTP queries are measured.

## Intl.Segmenter

A one-off manual check run during design review on 2026-10-04, not a committed script, so there is no artifact to re-run. It used the local Workers runtime this repository pins (`workerd` 1.20260825.1 in `pnpm-lock.yaml`, compatibility date 2026-08-01 in `apps/mcp/wrangler.toml`): Chinese, Japanese and Thai segment into words, and English keeps `user_id`, `fooBar`, `v2.3.1` and `café` whole. **Not yet checked on deployed staging.** Tokenizer v2 (Phase 5) ships behind a switch, and its first staging deploy carries a check that it segments Chinese before the switch is turned on.
