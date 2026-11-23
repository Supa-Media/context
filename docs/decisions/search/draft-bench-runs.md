# A search draft is benched in seconds, by the gateway

### A Lab draft is benched on the standing bench objects by the gateway, with no GitHub job

**Decided:** Dev2, 2026-11-23: "a change to search should be a lab change and a run of the benchmarks in the sandbox, less than a minute".

A Search bench run from the Lab's Evals goes through a GitHub job (`lab-eval-run.yml`). Checkout, install and reporting take about five minutes, but the standing bench objects answer every search in seconds. That job now also leaves the cases it asked beside the objects, by bench (`packages/lab/gateway/bench/plans.js`). These are its world, its copies, and each case's query, home and expected notes.

`tex_dev` `search_bench { draft?, bench? }` (the Lab route's `search_bench` op) then asks those kept cases again with no GitHub job and no load. It runs on main's search config and on the draft's, and every copy's share goes through a runner object of its own (`bench/run.js`), so no single Worker request carries every search. It answers right note first, top 5, found, MRR and p50 for both configs. It then lists every case whose rank moved, worst loss first, and the draft's misses with their top three.

The draft reaches the search as `SEARCH_CONFIG_DRAFT` in the bench environment only (`apps/mcp/src/search/config/benchDraft.js`). A real deployment's environment is never a bench one, so no variable there can change how a person's search runs. A draft the schema refuses is refused by the route and ignored by the search.

Never kept: a part handed in from outside (the sealed Test part, `--cases`) or one shard's share. A developer can never read the sealed set through this.

**What a simplification would cost:** benching a draft through GitHub again puts about five minutes back on every try. Letting a real deployment read `SEARCH_CONFIG_DRAFT` would let one variable change every person's search. **Tests:** `apps/mcp/test/benchRoute.test.mjs` "a remote run keeps its cases, and a draft is benched on them next to main with no load and no GitHub" and "only a bench environment searches on a draft config, and only one the schema accepts" (both sabotage-checked).
