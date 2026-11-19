/**
 * The self-test case table for check-workflow-triggers.mjs: each case is
 * [description, files, expectedFailures], run by `--self-test`. Each one breaks
 * exactly one thing and asserts the rule that must fire. The checker imports it
 * so the rule text and its cases stay in one file pair, and `--self-test` still
 * reports the count. Keep every case's comment beside it.
 */

export const cases = [
  [
    "a test workflow filtered to one base branch",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "a base filter written as a list item rather than a flow sequence",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    branches:\n      - main\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "the `*` that does not match a slashed branch name",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    branches: ['*']\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "a deploy workflow given a pull_request trigger",
    [{ name: "deploy-mcp.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["B deploy-mcp.yml"],
  ],
  [
    "pull_request_target anywhere",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n  pull_request_target:\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["B mcp.yml"],
  ],
  [
    "a push filter that is not main",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n  push:\n    branches: [main, release]\njobs: {}\n" }],
    ["C mcp.yml"],
  ],
  [
    "a push trigger with no branch filter at all",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n  push:\n    paths:\n      - \"apps/mcp/**\"\njobs: {}\n" }],
    ["C mcp.yml"],
  ],
  [
    "a CI workflow whose pull_request trigger was deleted instead of widened",
    [{ name: "mcp.yml", text: "on:\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["D mcp.yml"],
  ],
  [
    // Two problems, and the second is the point: `isDeploy` is behaviour OR
    // name, so a deploy workflow that slipped the convention is still refused
    // its `pull_request` trigger. The rename is reported beside it rather
    // than instead of it.
    "a deploying workflow that does not carry the name",
    [{ name: "ship.yml", text: "on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  d:\n    steps:\n      - run: npx convex deploy\n" }],
    ["NAME ship.yml", "B ship.yml"],
  ],
  [
    // The gap deploy-mobile-native.yml closed. A store submission is the most
    // outward-facing thing this repository can do, and until `eas submit`
    // joined DEPLOY_COMMANDS a workflow doing it was classified as ordinary
    // CI — free to grow a `pull_request` trigger and run a signed build from
    // a branch pushed here, reaching whatever that job's environment admits.
    //
    // Not a fork's branch: this used to say that, and it is the one actor
    // that cannot do it. A pull request from a fork inherits no secrets at
    // all — `ci.yml` says so a few lines into its own header, and relies on
    // it. The exposure is a SAME-REPO branch, this repository's normal shape:
    // agents push branches here and open pull requests against `main`. Those
    // runs are trusted, and `ci.yml` proves it in-repo — it is
    // `on: pull_request` with `secrets: inherit`, and per `sync-secrets.yml`
    // both `OP_SERVICE_ACCOUNT_TOKEN` and `GH_ADMIN_TOKEN` (a repo-admin PAT
    // with `secrets:write`) are REPOSITORY secrets, so a branch of ours
    // already reaches those.
    //
    // `EXPO_TOKEN` is not one of them, and the distinction is worth keeping:
    // it is a `production` ENVIRONMENT secret, reached only by a workflow that
    // names that environment and then held by the environment's own branch
    // policy and reviewers — GitHub settings this repository cannot show. It
    // is also the key to the signing credentials rather than the credentials,
    // which live on EAS.
    //
    // What the deploy NAME buys, precisely: it turns rule B ON
    // (`if (isDeploy && pr)`) and rule D OFF (`if (!isDeploy && …)`), which is
    // why the NAME rule calls wearing the name without deploying "an
    // exemption in disguise". Rule C is orthogonal — `if (triggers.has("push"))`
    // with no `isDeploy` guard, so it applies to every workflow, and the
    // self-test cases above expect `C mcp.yml` for an ordinary CI file. So is
    // B2, `if (triggers.has("pull_request_target"))`, ungated in the same way
    // and emitting the code `B` on any workflow — the case above expects
    // `B mcp.yml` for a plain one. So the name gates the two checks labelled
    // B, not everything that reports as `B`. An earlier version of this
    // paragraph said the name gated B *and C*; the suite forty lines up
    // already disproved it.
    "a store submission that does not carry the name",
    [{ name: "release.yml", text: "on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  d:\n    steps:\n      - run: eas submit --platform ios --latest --non-interactive\n" }],
    ["NAME release.yml", "B release.yml"],
  ],
  [
    "a native build that does not carry the name",
    [{ name: "release.yml", text: "on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  d:\n    steps:\n      - run: eas build --platform ios --profile production --non-interactive\n" }],
    ["NAME release.yml", "B release.yml"],
  ],
  [
    "the name used as an exemption by a workflow that deploys nothing",
    [{ name: "deploy-tests.yml", text: "on:\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["NAME deploy-tests.yml"],
  ],
  [
    "prose about deploying is not a deploy",
    [{ name: "mcp.yml", text: "# Never on pull_request: a wrangler deploy from a fork would be a breach.\non:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n" }],
    [],
  ],
  [
    "a workflow whose on: block declares nothing",
    [{ name: "mcp.yml", text: "on:\n\njobs: {}\n" }],
    ["PARSE mcp.yml"],
  ],
  [
    // Teaching the parser `schedule:` must not become "anything under
    // `schedule:` parses". A sequence entry that is not a `cron:` mapping is
    // still a shape this checker does not understand, and still fails.
    "a schedule entry that is not a cron mapping",
    [{ name: "gateway-health.yml", text: "on:\n  schedule:\n    - interval: hourly\njobs: {}\n" }],
    ["PARSE gateway-health.yml"],
  ],
  [
    // The empty-string spelling, which would otherwise record a schedule
    // that GitHub rejects and this checker called fine.
    "an empty cron expression",
    [{ name: "gateway-health.yml", text: "on:\n  schedule:\n    - cron: \"\"\njobs: {}\n" }],
    ["PARSE gateway-health.yml"],
  ],
  [
    // Rule A's three blind spots. Each restricts a `pull_request` exactly as
    // effectively as `branches:` does, and each passed silently while the
    // header claimed a shape it did not understand was a failure.
    "a base filter inverted into branches-ignore",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    branches-ignore: ['**']\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "the path filter every workflow header spends a paragraph forbidding",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    paths:\n      - \"apps/mcp/**\"\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "that filter inverted",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    paths-ignore: ['docs/**']\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "an activity filter that never fires while a pull request is open",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    types: [closed]\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "an activity filter that stops re-checking a pull request as it evolves",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    types: [opened, reopened]\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    // The two forms rule A must keep accepting. Without these the fix above
    // could be "restrict nothing is the only pass", which would fail the
    // repository's own six CI workflows the moment one spelled its default out.
    "the explicit every-branch filter, which is the documented allowance",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    branches: ['**']\n  push:\n    branches: [main]\njobs: {}\n" }],
    [],
  ],
  [
    "the default activity set, written out",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    types: [opened, synchronize, reopened]\n  push:\n    branches: [main]\njobs: {}\n" }],
    [],
  ],
  [
    // pr-description.yml re-runs other checks; it is not itself a check of
    // the pull request, so it may listen only for description edits. The
    // name is the whole allowance: the same filter on any other file is the
    // bug above.
    "the description workflow listens only for edits",
    [{ name: "pr-description.yml", text: "on:\n  pull_request:\n    types: [edited]\njobs: {}\n" }],
    [],
  ],
  [
    "another workflow cannot listen only for edits",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    types: [edited]\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["A mcp.yml"],
  ],
  [
    "the description workflow still cannot take a path filter",
    [{ name: "pr-description.yml", text: "on:\n  pull_request:\n    types: [edited]\n    paths:\n      - 'docs/**'\njobs: {}\n" }],
    ["A pr-description.yml"],
  ],
  [
    // Rule M. Without the trigger a required check never reports on the
    // merge queue's trial commit, and the queue waits on it.
    "a workflow that grades pull requests and not merge groups",
    [{ name: "mcp.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["M mcp.yml"],
  ],
  [
    "a merge group trigger that does not name its one activity",
    [{ name: "mcp.yml", text: "on:\n  pull_request:\n  merge_group:\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["M mcp.yml"],
  ],
  [
    "a merge group trigger filtered to one base branch",
    [{ name: "mcp.yml", text: "on:\n  pull_request:\n  merge_group:\n    types: [checks_requested]\n    branches: [main]\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["M mcp.yml"],
  ],
  [
    // The queue's trial commit is not main, and a deploy from it ships code
    // the queue may still drop.
    "a deploy workflow given a merge_group trigger",
    [{ name: "deploy-mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["B deploy-mcp.yml"],
  ],
  [
    "the description workflow grades nothing, so it need not listen for merge groups",
    [{ name: "pr-description.yml", text: "on:\n  pull_request:\n    types: [edited]\njobs: {}\n" }],
    [],
  ],
  [
    // Rule E, which no case reached until now: `parseOnBlock` throws for every
    // degenerate shape except this one, so E was reachable only through an
    // empty flow sequence and neutering it was invisible.
    "an on: block that is an empty flow sequence",
    [{ name: "mcp.yml", text: "on: []\njobs: {}\n" }],
    ["E mcp.yml"],
  ],
  [
    // `wrangler versions upload`, matched by no case and no real workflow
    // until now. It ships a Worker version with the account's credentials.
    "a deploy command this checker knows but had never matched",
    [{ name: "ship.yml", text: "on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler versions upload\n" }],
    ["NAME ship.yml"],
  ],
  [
    // The escalation guard, also never executed: a pull-request-triggered CI
    // workflow that calls a deploy workflow reaches production credentials
    // without ever naming a deploy command itself.
    "a CI workflow that calls a deploy workflow",
    [{ name: "mcp.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  d:\n    uses: ./.github/workflows/deploy-mcp.yml\n" }],
    ["NAME mcp.yml", "B mcp.yml"],
  ],
  [
    // `workflow_run` on a deploy workflow: the classic chain off a fork's
    // pull request CI run, which rule B did not name.
    "a deploy workflow chained off another workflow's run",
    [{ name: "deploy-mcp.yml", text: "on:\n  workflow_run:\n    workflows: [mcp]\n    types: [completed]\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["B deploy-mcp.yml"],
  ],
  [
    // Nesting under a trigger whose filters a rule reads. Flattened, the
    // depth-3 `branches` overwrote the depth-2 one and rule A passed a
    // workflow filtered to `main`.
    "a filter hidden from rule A by one level of nesting",
    [{ name: "mcp.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  pull_request:\n    branches: [main]\n    extra:\n      branches: ['**']\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["PARSE mcp.yml"],
  ],
  [
    // …and the depth-3 shape this repository legitimately uses, which must
    // keep flattening. Refusing depth everywhere would fail health-check.yml.
    "nesting under a trigger no rule reads the filters of",
    [{ name: "health-check.yml", text: "on:\n  workflow_dispatch:\n    inputs:\n      force_redeploy:\n        description: \"Force redeploy\"\n        type: boolean\njobs: {}\n" }],
    [],
  ],
  [
    // The preview lane's one allowed shape: a push to any branch but main,
    // from a deploy workflow with that exact name.
    "the preview workflow's exact push lane passes",
    [{ name: "deploy-preview.yml", text: "on:\n  push:\n    branches-ignore: [main]\n  workflow_dispatch:\n    inputs:\n      pr:\n        type: string\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    [],
  ],
  [
    // The same shape on any other deploy name is not an allowance: only the
    // preview may run on branches, so a production-shaped deploy is refused.
    "the preview's push shape on another deploy workflow fails C",
    [{ name: "deploy-mcp.yml", text: "on:\n  push:\n    branches-ignore: [main]\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["C deploy-mcp.yml"],
  ],
  [
    // The preview may not take pull requests either way: a deploy on a pull
    // request runs unreviewed code with the account's credentials.
    "the preview workflow given a pull_request trigger fails B",
    [{ name: "deploy-preview.yml", text: "on:\n  push:\n    branches-ignore: [main]\n  pull_request:\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["B deploy-preview.yml"],
  ],
  [
    "the preview workflow with a second ignored branch fails C",
    [{ name: "deploy-preview.yml", text: "on:\n  push:\n    branches-ignore: [main, x]\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["C deploy-preview.yml"],
  ],
  [
    "the preview workflow with an extra push key fails C",
    [{ name: "deploy-preview.yml", text: "on:\n  push:\n    branches-ignore: [main]\n    paths:\n      - \"apps/**\"\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["C deploy-preview.yml"],
  ],
  [
    // The preview allowance is for push only. A merge_group on it is refused
    // by rule B, as on every deploy workflow.
    "the preview workflow with a merge_group trigger fails B",
    [{ name: "deploy-preview.yml", text: "on:\n  merge_group:\n    types: [checks_requested]\n  push:\n    branches-ignore: [main]\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
    ["B deploy-preview.yml"],
  ],
  [
    // Rule D's one named excuse. The cleanup sweeps on a merge to main and
    // grades no pull request, so it has no pull_request trigger to pair with.
    "the preview cleanup runs on a merge to main without pull_request",
    [{ name: "preview-cleanup.yml", text: "on:\n  push:\n    branches: [main]\n  delete:\n  schedule:\n    - cron: \"23 5 * * *\"\n  workflow_dispatch:\njobs: {}\n" }],
    [],
  ],
  [
    // The excuse is the name, not the shape: any other workflow on a push to
    // main alone still has to see pull requests.
    "the same push shape on another name still fails D",
    [{ name: "sweep.yml", text: "on:\n  push:\n    branches: [main]\njobs: {}\n" }],
    ["D sweep.yml"],
  ],
];
