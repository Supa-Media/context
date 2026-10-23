# A pull request runs the Convex tests its change reaches

_Decided 2026-10-23, from the owner's ask that a Tex change clear CI in under
two minutes and reach production in about five. See
[CI pipelines](./ci-pipelines.md) for the path filters this sits inside._

## What was slow

Measured on the Tex pull requests #2094 to #2109: every check but one finished
in about a minute. `ci / Test Convex Backend` took four to six minutes, on
every pull request that touched `apps/convex` at all, because it ran all 545
files. One file, `contextMoveEndToEnd.test.ts`, takes about three minutes on
its own, so whichever of the three shards drew it was always last.

"Run the tests that import the changed file" does not help here. Every
`convexTest()` loads function modules from one lazy glob, and `http.ts`
imports all 34 gateway route modules, so by import a change to
`functions/lib/gatewayRoutes/calendarWrite.ts` reaches about 240 test files
that never send it a request.

## What runs now

On pushes to `main`, the Convex suite runs in full, on six shards, with
`CONVEX_TEST_MAP_RECORD` set. `apps/convex/testImpact.setup.ts` then writes,
per test file, the repository files that test **used**:

- a file in which any function ran, other than its module wrapper and the
  short `get` accessors vite writes for each export (reading
  `routes.handler` runs one; it does not run the handler);
- a file imported as `?raw`, whose text is what the test checks;
- a file or directory the test's own code read or listed through `node:fs`
  (reads vitest makes while loading modules do not count).

The reusable CI workflow (`convex-test-map` in supa-framework) saves the merged
map to the Actions cache. A pull request restores the newest one, and
`scripts/convex-tests.mjs` runs:

- every test file the pull request adds or edits, and every one the map has
  not seen;
- every test that used a file the pull request edits or deletes;
- for an added or deleted file, every test that listed its directory or used
  at least half of the files in it, which is what a glob looks like from
  outside.

It runs everything when it cannot reason about the change: no map, no list of
changed files, or a change to the schema, `_generated/`, the test setup or
config, the selector itself, or the install inputs (`RUN_EVERYTHING`).

Replayed against the recorded map: #2094 runs 15 of 545 files, #2097 and
#2099 about 18% of the suite's time, #2109 21%, #2101 and #2103 52% (both
edit `http.ts`, which every HTTP test runs), and #2107 all of it (it edits a
schema file). Recording costs about 8% on the full run.

## Why this is safe enough

A selection can miss a test: a constant read only at module load, or a
behaviour reached through a path the map's last recording did not take. So
the selection is not the last word: `main` runs the whole suite on every
merge. Under `AUTO_DEPLOY_PRODUCTION=after-staging`,
`scripts/production-release.mjs` refuses a commit whose CI on `main` has not
passed, so a missed failure stops the release. By default (owner, 2026-10-23)
production deploys beside staging and does not wait for that run, so a missed
failure can ship and is caught minutes later on `main`, where the next merge
fixes it; that is the trade the owner chose for a five-minute release.

**What a simplification costs.** Dropping the coverage filter for plain
imports puts every HTTP test back on every Tex change. Dropping the
`RUN_EVERYTHING` list lets a schema change run nothing. Dropping the
production check on `main`'s CI removes the one setting that keeps a missed
test out of production.
`scripts/convex-tests.test.mjs` pins each rule, and
`production-release.test.mjs` fails if production stops requiring CI.
