# @context/bench — every benchmark, one folder each

A benchmark is a folder under `benchmarks/<id>/` with two files:

- **`bench.json`** — what it is and how it runs:

  ```json
  {
    "id": "my-bench",
    "title": "My bench",
    "kind": "search",
    "format": "beir",
    "about": "One sentence the Lab shows.",
    "source": { "name": "Where the data comes from", "url": "https://…", "license": "MIT" },
    "notes": { "workspace": "sam", "as": "Sam", "folder": "resources" },
    "score": "beir",
    "slice": "spread",
    "caseIds": "query",
    "runs": [{ "id": "my-bench", "variant": "All", "total": 120, "about": "What this run measures." }]
  }
  ```

  `kind` is `search` (one `search_notes` call per question, embeddings only) or `memory` (the documents saved as
  sessions, a reader answers, a judge grades). `format` is `beir` (the source returns BEIR sets) or `custom` (the
  source builds its own worlds). `score` is `beir` (nDCG@10, Recall@10, MRR@10 per group, averaged over groups),
  `first` (right note first, top 5, MRR) or `retrieval` (answer notes in the top 5). Each run may override `kind`,
  `score`, `sets` and add its own fields, which the source reads (`corpus`, `file`, …).

- **`source.mjs`** — how it reads its data. A `beir` source exports `load({ run, dir, data, sets, n })` and returns
  an array of sets; a `custom` source exports `worlds({ run, dir, part, cases, today, sets, helpers })`.

## The data: BEIR's files

A set is BEIR's open layout, so any BEIR set drops in as it is:

```
corpus.jsonl     {"_id", "title", "text"}               one document per line
queries.jsonl    {"_id", "text"}                        one question per line
qrels/test.tsv   query-id  corpus-id  score             with a header line
```

Optional fields say what BEIR cannot: a document's `path` (where it is kept as a note, e.g.
`projects/launch/plan.md`), `workspace`, `date` (a memory run's session time) and `group` (one world per group); a
query's `kind` (the group it is scored in), `answer` and `date` (for a memory run), `bm25` (a reference ranking) and
`as` (who searches). `src/beir.mjs` writes and reads these files (`writeBeir`, `readBeir`) and turns a set into notes
and cases (`beirWorlds`) or memory cases (`memoryCases`).

Public data is fetched at run time into the run's `--fetch` folder (`src/hub.mjs` reads the Hugging Face Hub at the
revision it names) and never committed. Only made-up data lives in this repository.

## Adding one

1. Make `benchmarks/<id>/` with `bench.json` and `source.mjs`.
2. Test its source on made-up data in `test/beir.test.mjs`.
3. `node packages/bench/scripts/registry.mjs` to rewrite `benchmarks.generated.json` (fast guards fail when it is
   stale or a folder is malformed). The Lab, `tex_dev evals` and `.github/workflows/lab-eval-run.yml` list it from
   there.
4. Run it: `node apps/mcp/bench/evals/cli.mjs search --bench <run id> --fetch <dir> --n 20 --out result.json --fake`
   (`longmemeval --bench <run id>` for a memory run).

Why it is shaped this way: `docs/decisions/search/search-suite.md`.
