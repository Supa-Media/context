#!/usr/bin/env node
/**
 * Every workflow's `on:` block, checked against the two rules that decide
 * whether a pull request is examined at all — and whether an untrusted one can
 * reach production credentials.
 *
 * ── WHAT WENT WRONG ───────────────────────────────────────────────────────
 *
 * Every test workflow said:
 *
 *   on:
 *     pull_request:
 *       branches: [main]
 *
 * which reads as "check pull requests" and means "check pull requests INTO
 * main". A pull request based on any other branch therefore ran NO checks at
 * all — not a failing check, not a pending one: zero check runs. Measured on
 * #169 (base `offline/notes-cache`), which had none across its whole life and
 * was merged on local test runs alone.
 *
 * Stacked pull requests are the normal shape in this repository, because basing
 * a fix on the pull request it fixes is what keeps its diff reviewable. So
 * CLAUDE.md's "merge only on green CI, and never on red" silently did not apply
 * to exactly those pull requests — there was no green to be had, and nothing
 * said so. That is this repository's most-repeated failure shape (a check that
 * is green, or absent, because it did not execute) wearing a base-branch
 * filter.
 *
 * ── AND THE HALF THAT MUST NOT BE "FIXED" THE SAME WAY ─────────────────────
 *
 * The deploy workflows are `push`-only by deliberate design, and each says so
 * in its own header: a deploy triggered by a pull request from a branch pushed
 * *here* would run unreviewed code with the account's credentials, against the
 * Worker that holds customers' storage keys and the one that reads their mail.
 *
 * **A branch, not a fork** — and the difference is the whole point, because the
 * intuition runs the other way. A fork's pull request inherits no secrets at
 * all; `ci.yml`'s header says so a few lines in and relies on it. A same-repo
 * branch is trusted by Actions: its run inherits repository secrets, and it may
 * name the `production` environment, which is then gated only by that
 * environment's own branch policy and reviewers — settings that live in GitHub
 * and not in this repository. So the actor this guard actually bounds is one of
 * ours, and saying "fork" made it sound like protection from outsiders while
 * describing the one case that cannot happen.
 *
 * That hazard is why this checker's more important assertion is the negative
 * one — no deploy workflow may grow a `pull_request` trigger — and it is the
 * reason this is a guard rather than a one-off edit. Widening the test
 * workflows is the kind of change whose obvious next step ("make them all
 * consistent") is a breach.
 *
 * ── WHY IT PARSES RATHER THAN GREPS ───────────────────────────────────────
 *
 * `grep -l pull_request .github/workflows/*.yml` matches all seven deploy
 * workflows, because each explains in prose why it has no such trigger. A
 * grep-shaped guard would read those comments as configuration and report the
 * opposite of the truth. So the `on:` block is parsed, and `problems.length ===
 * 0` must mean "the rules were evaluated and held", never "nothing matched".
 *
 * The first version of this paragraph claimed a shape the checker does not
 * understand is "a failure, never a pass", full stop. That was false in the one
 * place it most needed to be true, and it was false in the commit that
 * introduced the guard: rule A read `pull_request`'s `branches:` and nothing
 * else, so `branches-ignore`, `paths` and `paths-ignore` — three keys that
 * restrict a pull request exactly as effectively — were not shapes it refused
 * but shapes it did not look at.
 * `branches-ignore: ['**']` passed while running the workflow on no pull request
 * at all, which is strictly worse than the bug this file was written for. So the
 * claim is now bounded to what is enforced:
 *
 *   - Under `pull_request` and `push`, every key is understood or refused, and
 *     nesting is refused rather than flattened.
 *   - Under every other trigger, depth 3 and beyond is FLATTENED into the
 *     depth-2 object, not rejected — `workflow_dispatch.inputs.force_redeploy.
 *     description` in health-check.yml arrives as `config.description`. No rule
 *     reads those triggers' configuration, so nothing turns on it.
 *   - The deploy-command detector is a denylist and is not a shape check at
 *     all. See DEPLOY_COMMANDS.
 *
 * ── HOW THE TWO SETS ARE DERIVED ──────────────────────────────────────────
 *
 * Not from two hand-maintained lists, which would drift the day somebody adds a
 * workflow. A deploy workflow is one named `deploy-*.yml`, and the convention is
 * ASSERTED IN BOTH DIRECTIONS rather than assumed: a file that runs a deploy
 * command must carry the name (or the deploy set is missing a member), and a
 * file carrying the name must run one (or the name is an exemption in
 * disguise — rename a test workflow to `deploy-tests.yml` and it would
 * otherwise be excused from ever running on a pull request).
 *
 * "Both directions" is only as strong as the denylist under it, and that is
 * stated here rather than discovered later: the name→deploys direction is
 * exact, and the deploys→name direction is worth precisely what DEPLOY_COMMANDS
 * matches. What holds the convention up today is not the regex list, it is that
 * all seven deploys are correctly named right now — a fact this checker re-proves
 * on every run — and that a seventh has to be written by somebody.
 *
 * `health-check.yml` is in neither set and that is not an oversight: it can
 * redeploy production and it inherits secrets, and what keeps it safe is that
 * nothing about a branch triggers it — no `push`, no `pull_request`, only
 * `workflow_dispatch`. Rule D is written so that any workflow which acquires a
 * `push` trigger has to answer for a `pull_request` one too.
 *
 * ── WHERE IT RUNS ─────────────────────────────────────────────────────────
 *
 * From two workflows (mcp.yml and email-worker.yml), on purpose. A checker
 * hosted in one workflow is blind to that workflow's own trigger being narrowed
 * — narrow it and the job simply does not run on the pull request that narrowed
 * it, which is the bug it exists to catch. Two hosts means one narrowing is
 * always caught by the other. The residual is stated rather than papered over:
 * a single change narrowing BOTH would go unreported on its own pull request,
 * and would fail on the push run to `main` afterwards, because both files list
 * their own path in their `push:` filter.
 *
 * Run `node scripts/check-workflow-triggers.mjs --self-test` to prove the rules
 * catch what they claim.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = ".github/workflows";

/**
 * Commands that put this repository's credentials to work somewhere real.
 *
 * Matched against non-comment lines only — every deploy workflow's header
 * discusses deploying, and a detector that read prose is the grep this file
 * exists to avoid.
 *
 * THIS IS A DENYLIST, and no amount of adding to it becomes an allowlist. Every
 * one of these deploys and is matched by nothing here:
 *
 *   uses: cloudflare/wrangler-action@v3   (with `command: deploy` on a later line)
 *   npm publish
 *   npx vercel --prod
 *   aws s3 sync ...
 *   fastlane deliver
 *   wrangler \                            (a line continuation, then `deploy`)
 *   CMD=deploy; wrangler $CMD
 *
 * Do not try to close that list; the next shape is always one substitution away,
 * and a checker that pretends otherwise is the "guard nobody has checked" this
 * repository keeps meeting. The real bound is stated instead, and it is a fact
 * about today rather than a property of the code: all seven deploy workflows are
 * correctly named `deploy-*.yml`, so every one of them is classified by NAME
 * before any command is read, and rules B and C apply to them whatever they run.
 * What this list actually buys is the other direction — a NEW workflow that
 * deploys in one of these eight obvious ways cannot quietly avoid the name.
 */
const DEPLOY_COMMANDS = [
  /\bwrangler\s+(?:pages\s+)?deploy\b/,
  /\bwrangler\s+versions\s+upload\b/,
  /\bconvex\s+deploy\b/,
  /\beas\s+deploy\b/,
  /\beas\s+update\b/,
  // `eas build` signs a binary with the account's distribution certificate and
  // `eas submit` hands it to a store. Both were unmatched until
  // deploy-mobile-native.yml was written, and the list above used
  // `eas build --auto-submit` as its example of the gap — accurate, and the
  // reason a workflow that submits to the App Store could have worn any name.
  /\beas\s+build\b/,
  /\beas\s+submit\b/,
  /\buses:\s*\S*deploy[^\s]*\.ya?ml/,
];

/** A base-branch filter this checker accepts as "every branch". */
const EVERY_BRANCH = "**";

/**
 * The four keys that narrow which pull requests a workflow runs on. Rule A read
 * only the first when this guard was written, and the other three restrict just
 * as effectively — see rule A.
 */
const PR_FILTER_KEYS = ["branches", "branches-ignore", "paths", "paths-ignore"];

/**
 * The default activity set. A `types:` filter missing any of these leaves a pull
 * request unchecked at the moments that matter: opened, pushed to, reopened.
 */
const REQUIRED_PR_TYPES = ["opened", "synchronize", "reopened"];

/**
 * The two triggers whose configuration a rule below actually reads (A and C).
 * Nesting under these is refused rather than flattened — see `parseOnBlock`.
 */
const FILTERED_TRIGGERS = new Set(["pull_request", "push"]);

class WorkflowShapeError extends Error {}

function stripComments(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

export function deploysSomething(text) {
  const code = stripComments(text);
  return DEPLOY_COMMANDS.some((re) => re.test(code));
}

function unquote(value) {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function flowSequence(value) {
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => unquote(item))
    .filter((item) => item !== "");
}

/**
 * The `on:` block, and nothing else in the file.
 *
 * Returns a Map of trigger name → null (no configuration) or an object of
 * `key → string[] | string | null`. Two levels is all GitHub's trigger syntax
 * needs for the keys these rules read.
 *
 * Anything STRANGER throws. Anything DEEPER is a split, and the earlier comment
 * here claimed the throw covered both: under `pull_request` and `push` — the two
 * triggers whose filters a rule reads — a nested key throws, because flattened
 * it can overwrite the very filter rule A inspects. Under every other trigger it
 * is flattened into the depth-2 object, which is how health-check.yml's
 * `workflow_dispatch.inputs.force_redeploy.description` arrives as
 * `config.description` rather than as an error.
 */
export function parseOnBlock(text, file = "<input>") {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^(?:on|"on"|'on')\s*:/.test(line));
  if (start === -1) {
    throw new WorkflowShapeError(`${file}: no top-level \`on:\` key.`);
  }

  const inline = lines[start].replace(/^(?:on|"on"|'on')\s*:/, "").trim();
  if (inline !== "" && !inline.startsWith("#")) {
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return new Map(flowSequence(inline).map((name) => [name, null]));
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inline)) {
      return new Map([[inline, null]]);
    }
    throw new WorkflowShapeError(`${file}:${start + 1}: \`on: ${inline}\` is a shape this checker does not understand.`);
  }

  // The block runs until the next line that is neither blank nor a comment and
  // sits at column 0 — i.e. the next top-level key.
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.trim();
    if (bare === "" || bare.startsWith("#")) continue;
    if (line.search(/\S/) === 0) break;
    body.push({ line: i + 1, text: line });
  }
  if (body.length === 0) {
    throw new WorkflowShapeError(`${file}: \`on:\` declares no triggers.`);
  }

  const triggerIndent = body[0].text.search(/\S/);
  const triggers = new Map();
  let current = null;
  let currentKey = null;
  let configIndent = null;

  for (const { line, text: raw } of body) {
    const indent = raw.search(/\S/);
    const content = raw.trim();

    if (indent === triggerIndent) {
      const m = content.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) {
        throw new WorkflowShapeError(`${file}:${line}: \`${content}\` is not a trigger this checker understands.`);
      }
      const [, name, value] = m;
      current = null;
      currentKey = null;
      configIndent = null;
      if (value === "" || value.startsWith("#")) {
        triggers.set(name, null);
        current = name;
      } else {
        throw new WorkflowShapeError(`${file}:${line}: inline trigger value \`${value}\` is a shape this checker does not understand.`);
      }
      continue;
    }

    if (current === null) {
      throw new WorkflowShapeError(`${file}:${line}: indented line with no trigger above it.`);
    }

    const listItem = content.match(/^-\s*(.+)$/);
    if (listItem) {
      if (currentKey === null) {
        throw new WorkflowShapeError(`${file}:${line}: list item with no key above it.`);
      }
      const config = triggers.get(current);
      if (!Array.isArray(config[currentKey])) config[currentKey] = [];
      config[currentKey].push(unquote(listItem[1]));
      continue;
    }

    const keyed = content.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!keyed) {
      throw new WorkflowShapeError(`${file}:${line}: \`${content}\` is a shape this checker does not understand.`);
    }
    const [, key, value] = keyed;
    if (configIndent === null) configIndent = indent;
    // Depth 3 and beyond is flattened into the depth-2 object, which is
    // harmless for `workflow_dispatch.inputs` and is a rule A bypass under the
    // two triggers a rule reads: `pull_request: {branches: [main], x: {branches:
    // ['**']}}` flattens to `branches: ['**']` and passes. GitHub's own schema
    // rejects an unknown key there, so this was never exploitable in a workflow
    // that runs — but "the workflow had to be invalid" is somebody else's
    // validator holding this guard up, which is not a bound this file gets to
    // rely on. Refused here, and only here, so the depth-3 shape the repository
    // legitimately uses keeps parsing.
    if (indent > configIndent && FILTERED_TRIGGERS.has(current)) {
      throw new WorkflowShapeError(`${file}:${line}: \`${key}:\` is nested inside \`${current}:\`, and this checker reads that trigger's filters. Flattening it would let a nested key overwrite the filter a rule reads.`);
    }
    if (triggers.get(current) === null) triggers.set(current, {});
    const config = triggers.get(current);
    currentKey = key;
    if (value === "" || value.startsWith("#")) {
      config[key] = null;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      config[key] = flowSequence(value);
    } else {
      config[key] = unquote(value);
    }
  }

  return triggers;
}

function describe(value) {
  if (value === null || value === undefined) return "(absent)";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return String(value);
}

/**
 * @param {{name: string, text: string}[]} files
 * @returns {{problems: {rule: string, file: string, message: string}[], counts: object}}
 */
export function analyse(files) {
  const problems = [];
  const fail = (rule, file, message) => problems.push({ rule, file, message });

  let ci = 0;
  let deploy = 0;

  for (const { name, text } of files) {
    let triggers;
    try {
      triggers = parseOnBlock(text, name);
    } catch (error) {
      fail("PARSE", name, error.message);
      continue;
    }

    // E — a workflow with no triggers is dead configuration, and is refused.
    //
    // E used to be described as "what makes this whole checker fail loudly
    // instead of passing everything" when the parser breaks. It is not, and the
    // claim was unfalsifiable in the most literal way: `parseOnBlock` THROWS for
    // every degenerate shape except an empty flow sequence, so `on: []` is the
    // only input that reaches E, no self-test case used it, and neutering E was
    // invisible to the suite. There is a case for it now.
    //
    // What actually backstops a broken parser is a pair of assertions elsewhere:
    // the self-test's good-corpus `counts` check (a parser returning nothing
    // classifies zero CI and zero deploy workflows) and the positive rule cases
    // (each expects a named rule to fire, which a parser returning nothing
    // cannot produce). The live run repeats the first: `counts.ci === 0 ||
    // counts.deploy === 0` exits non-zero before any problem list is printed.
    if (triggers.size === 0) {
      fail("E", name, "declares no triggers — either the file is dead configuration or this checker's parser stopped understanding it.");
      continue;
    }

    const named = /^deploy-.+\.ya?ml$/.test(name);
    const deploys = deploysSomething(text);

    // NAME — the filename convention IS the classification, so it is checked in
    // both directions rather than trusted.
    if (deploys && !named) {
      fail("NAME", name, "runs a deploy command but is not named `deploy-*.yml`, so the deploy rules below never applied to it. Rename it.");
    }
    if (named && !deploys) {
      fail("NAME", name, "is named `deploy-*.yml` but runs no deploy command. The name excuses a workflow from having to run on pull requests, so wearing it without deploying is an exemption in disguise.");
    }

    const isDeploy = named || deploys;
    if (isDeploy) deploy += 1;

    const pr = triggers.has("pull_request");

    // B — the security half. A deploy triggered by a pull request from a branch
    // pushed here would run unreviewed code with the account's credentials.
    // Said as "a branch" and not "a fork" deliberately: a fork's run inherits no
    // secrets, so naming it would hand anybody tripping this rule a rationale
    // they can refute in ten seconds — and the natural next move after refuting
    // a guard's stated reason is to delete the guard.
    if (isDeploy && pr) {
      fail("B", name, "is a deploy workflow with a `pull_request` trigger. A pull request opened here runs unreviewed code with the account's credentials — a same-repo run is trusted by Actions, unlike a fork's; deploy workflows are `push`-only.");
    }

    // B — `workflow_run` fires after another workflow finishes, with the base
    // branch's secrets and a writable token, and the run it chains off may have
    // been a fork's pull request. It is the classic escalation: CI is allowed to
    // run untrusted code precisely because it holds nothing, and this hands the
    // result of that run the credentials CI was denied. It is forbidden on
    // deploy workflows rather than everywhere, because a non-deploy workflow
    // that acquires one is caught by the pair above it — anything that reaches a
    // deploy command is a deploy workflow by `deploysSomething`, whatever it is
    // named. Nothing in this repository uses `workflow_run`.
    if (isDeploy && triggers.has("workflow_run")) {
      fail("B", name, "is a deploy workflow triggered by `workflow_run`. That chains production credentials onto the completion of another workflow, which may itself have been triggered by a fork's pull request; deploy workflows are `push`-only.");
    }

    // B2 — `pull_request_target` runs with the base branch's secrets and a
    // writable token while checking out a contributor's changes on request.
    // Nothing here uses it and nothing here should; it is the shape that turns
    // "we widened CI" into a credential leak.
    if (triggers.has("pull_request_target")) {
      fail("B", name, "uses `pull_request_target`, which hands a fork's pull request the base branch's secrets. Use `pull_request`.");
    }

    // A — the bug this file was written for, and the three sibling keys that
    // reproduce it exactly. Reading `branches:` alone was the original guard,
    // and it passed all three silently: `branches-ignore: ['**']` runs the
    // workflow on NO pull request at all, which is strictly worse than the bug
    // being fixed; `paths:` is the filter every workflow header here spends a
    // paragraph forbidding; `types:` without the default set stops the workflow
    // re-running as the pull request evolves. Absence is the only free pass,
    // plus the one documented allowance below.
    if (pr) {
      const config = triggers.get("pull_request");

      for (const key of PR_FILTER_KEYS) {
        const value = config === null ? undefined : config[key];
        if (value === undefined) continue;
        // `branches: ['**']` is spelling the default out, and is accepted. No
        // such allowance exists for the other three: there is no way to write
        // `paths:` that means "every path", you write no `paths:` key.
        if (
          key === "branches" &&
          Array.isArray(value) &&
          value.length === 1 &&
          value[0] === EVERY_BRANCH
        ) {
          continue;
        }
        fail(
          "A",
          name,
          `restricts \`pull_request\` with \`${key}: ${value === null ? "(empty)" : describe(value)}\`. A pull request outside that filter then runs no checks at all — not a failing check, none. Remove the \`${key}:\` key.`
        );
      }

      // `types:` is not a yes/no filter: the question is whether the three
      // events that make a pull request get checked as it evolves survive it.
      const types = config === null ? undefined : config.types;
      if (types !== undefined) {
        const declared = Array.isArray(types) ? types : types === null ? [] : [String(types)];
        const missing = REQUIRED_PR_TYPES.filter((t) => !declared.includes(t));
        if (missing.length > 0) {
          fail(
            "A",
            name,
            `restricts \`pull_request\` to types ${types === null ? "(empty)" : describe(types)}, which drops ${missing.join(", ")}. Those three are the default set, and without them a pull request is not checked when it is opened, when it is pushed to, or when it is reopened. Remove the \`types:\` key.`
          );
        }
      }
    }

    if (!isDeploy && (triggers.has("push") || pr)) ci += 1;

    // D — the anchor. Without it, deleting a `pull_request:` trigger outright
    // would escape rule A silently. A workflow that runs on pushes to `main` is
    // a workflow whose jobs are meant to see this repository's code; running
    // them only after the merge is checking the wrong side of the door.
    if (!isDeploy && triggers.has("push") && !pr) {
      fail("D", name, "runs on `push` but not on `pull_request`, so its jobs only see code that has already landed.");
    }

    // C — the push lane is unchanged and must stay that way: it is the deploy
    // workflows' neighbour, not a pull request's check.
    if (triggers.has("push")) {
      const config = triggers.get("push");
      const branches = config === null ? undefined : config.branches;
      const onlyMain = Array.isArray(branches) && branches.length === 1 && branches[0] === "main";
      if (!onlyMain) {
        fail("C", name, `has \`push: branches: ${describe(branches)}\`, and it must be [main]. Every push run of this repository is a run against the default branch.`);
      }
    }
  }

  return { problems, counts: { files: files.length, ci, deploy } };
}

function readWorkflows() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
}

/**
 * The checker, checked. Each case breaks exactly one thing and asserts the rule
 * that must fire — a self-test that only proves the good corpus passes is a
 * self-test that a `return []` also passes.
 */
function selfTest() {
  const good = [
    { name: "mcp.yml", text: "name: A\non:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n" },
    { name: "deploy-mcp.yml", text: "name: B\n# never on pull_request, see header\non:\n  push:\n    branches: [main]\n    paths:\n      - \"apps/mcp/**\"\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" },
    { name: "health-check.yml", text: "name: C\non:\n  workflow_dispatch:\njobs: {}\n" },
  ];

  const rulesFor = (files) => analyse(files).problems.map((p) => `${p.rule} ${p.file}`);

  const clean = analyse(good);
  if (clean.problems.length !== 0) {
    throw new Error("self-test: the good corpus must report nothing, got " + JSON.stringify(clean.problems));
  }
  if (clean.counts.ci !== 1 || clean.counts.deploy !== 1) {
    throw new Error("self-test: the good corpus must classify one CI and one deploy workflow, got " + JSON.stringify(clean.counts));
  }

  const cases = [
    [
      "a test workflow filtered to one base branch",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      "a base filter written as a list item rather than a flow sequence",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    branches:\n      - main\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      "the `*` that does not match a slashed branch name",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    branches: ['*']\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      "a deploy workflow given a pull_request trigger",
      [{ name: "deploy-mcp.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n" }],
      ["B deploy-mcp.yml"],
    ],
    [
      "pull_request_target anywhere",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n  pull_request_target:\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["B mcp.yml"],
    ],
    [
      "a push filter that is not main",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main, release]\njobs: {}\n" }],
      ["C mcp.yml"],
    ],
    [
      "a push trigger with no branch filter at all",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n  push:\n    paths:\n      - \"apps/mcp/**\"\njobs: {}\n" }],
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
      // self-test cases above expect `C mcp.yml` for an ordinary CI file. An
      // earlier version of this paragraph said the name gated B *and C*; the
      // suite forty lines up already disproved it.
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
      [{ name: "mcp.yml", text: "# Never on pull_request: a wrangler deploy from a fork would be a breach.\non:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n" }],
      [],
    ],
    [
      "a workflow whose on: block declares nothing",
      [{ name: "mcp.yml", text: "on:\n\njobs: {}\n" }],
      ["PARSE mcp.yml"],
    ],
    [
      // Rule A's three blind spots. Each restricts a `pull_request` exactly as
      // effectively as `branches:` does, and each passed silently while the
      // header claimed a shape it did not understand was a failure.
      "a base filter inverted into branches-ignore",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    branches-ignore: ['**']\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      "the path filter every workflow header spends a paragraph forbidding",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    paths:\n      - \"apps/mcp/**\"\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      "that filter inverted",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    paths-ignore: ['docs/**']\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      "an activity filter that never fires while a pull request is open",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    types: [closed]\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      "an activity filter that stops re-checking a pull request as it evolves",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    types: [opened, reopened]\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["A mcp.yml"],
    ],
    [
      // The two forms rule A must keep accepting. Without these the fix above
      // could be "restrict nothing is the only pass", which would fail the
      // repository's own six CI workflows the moment one spelled its default out.
      "the explicit every-branch filter, which is the documented allowance",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    branches: ['**']\n  push:\n    branches: [main]\njobs: {}\n" }],
      [],
    ],
    [
      "the default activity set, written out",
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n  push:\n    branches: [main]\njobs: {}\n" }],
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
      [{ name: "mcp.yml", text: "on:\n  pull_request:\n    branches: [main]\n    extra:\n      branches: ['**']\n  push:\n    branches: [main]\njobs: {}\n" }],
      ["PARSE mcp.yml"],
    ],
    [
      // …and the depth-3 shape this repository legitimately uses, which must
      // keep flattening. Refusing depth everywhere would fail health-check.yml.
      "nesting under a trigger no rule reads the filters of",
      [{ name: "health-check.yml", text: "on:\n  workflow_dispatch:\n    inputs:\n      force_redeploy:\n        description: \"Force redeploy\"\n        type: boolean\njobs: {}\n" }],
      [],
    ],
  ];

  for (const [label, files, expected] of cases) {
    const got = rulesFor(files);
    const same = got.length === expected.length && got.every((r, i) => r === expected[i]);
    if (!same) {
      throw new Error(`self-test: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  }

  // The parser refuses what it does not understand rather than returning an
  // empty trigger set, which would read as "no rules apply".
  let threw = false;
  try {
    parseOnBlock("on:\n  pull_request: [opened]\njobs: {}\n", "x.yml");
  } catch (error) {
    threw = error instanceof WorkflowShapeError;
  }
  if (!threw) throw new Error("self-test: the parser accepted a shape it does not understand.");

  console.log(`ok   self-test passed (${cases.length + 2} cases)`);
}

let invokedAs = null;
try {
  invokedAs = process.argv[1] ? realpathSync(process.argv[1]) : null;
} catch {
  invokedAs = null;
}
if (invokedAs && import.meta.url === pathToFileURL(invokedAs).href) {
  if (process.argv.slice(2).includes("--self-test")) {
    selfTest();
    process.exit(0);
  }

  const files = readWorkflows();
  const { problems, counts } = analyse(files);

  // A scan that matched nothing is not a pass. Both sets must be non-empty:
  // this repository has test workflows and it has deploy workflows, and a run
  // reporting otherwise found a wrong directory or a broken parser.
  if (counts.ci === 0 || counts.deploy === 0) {
    console.error(
      `Examined ${counts.files} workflow file(s) and classified ${counts.ci} as CI and ${counts.deploy} as deploys.\n\n` +
        "Both sets must be non-empty. A checker that matches nothing is not a\n" +
        "checker that passes — it has stopped reading the workflows."
    );
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("Workflow triggers break the rules in this script's header:\n");
    for (const p of problems) console.error(`  [${p.rule}] ${p.file}: ${p.message}`);
    console.error("");
    process.exit(1);
  }

  console.log(
    `OK — ${counts.ci} CI workflow(s) accept pull requests on any base branch, ` +
      `${counts.deploy} deploy workflow(s) accept none, and every push filter is [main].`
  );
}
