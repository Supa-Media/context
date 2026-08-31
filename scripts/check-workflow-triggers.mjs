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
 * in its own header: a deploy triggered by a fork's pull request would run
 * untrusted code with the account's Cloudflare credentials, against the Worker
 * that holds customers' storage keys and the one that reads their mail. This
 * checker's more important assertion is therefore the negative one — no deploy
 * workflow may grow a `pull_request` trigger — and it is the reason this is a
 * guard rather than a one-off edit. Widening the test workflows is the kind of
 * change whose obvious next step ("make them all consistent") is a breach.
 *
 * ── WHY IT PARSES RATHER THAN GREPS ───────────────────────────────────────
 *
 * `grep -l pull_request .github/workflows/*.yml` matches all six deploy
 * workflows, because each explains in prose why it has no such trigger. A
 * grep-shaped guard would read those comments as configuration and report the
 * opposite of the truth. So the `on:` block is parsed, and the parser is
 * deliberately strict: a shape it does not understand is a failure, never a
 * pass. `problems.length === 0` must mean "the rules were evaluated and held",
 * never "nothing matched".
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
 */
const DEPLOY_COMMANDS = [
  /\bwrangler\s+(?:pages\s+)?deploy\b/,
  /\bwrangler\s+versions\s+upload\b/,
  /\bconvex\s+deploy\b/,
  /\beas\s+deploy\b/,
  /\beas\s+update\b/,
  /\buses:\s*\S*deploy[^\s]*\.ya?ml/,
];

/** A base-branch filter this checker accepts as "every branch". */
const EVERY_BRANCH = "**";

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
 * needs for the keys these rules read, and anything deeper or stranger throws:
 * a checker that shrugs at a shape it has not seen is a checker that passes a
 * file it never understood.
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

    // E — a workflow with no triggers is dead configuration, and is also what a
    // broken parser reports for every file. Every other rule below is written as
    // "if this trigger is present…", so without E a parser that returned nothing
    // would make this whole checker pass silently. That is the failure this
    // repository keeps meeting, so it is asserted rather than assumed.
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

    // B — the security half. A deploy triggered by a fork's pull request would
    // run untrusted code with production credentials.
    if (isDeploy && pr) {
      fail("B", name, "is a deploy workflow with a `pull_request` trigger. A deploy triggered by a fork's pull request runs untrusted code with the account's credentials; deploy workflows are `push`-only.");
    }

    // B2 — `pull_request_target` runs with the base branch's secrets and a
    // writable token while checking out a contributor's changes on request.
    // Nothing here uses it and nothing here should; it is the shape that turns
    // "we widened CI" into a credential leak.
    if (triggers.has("pull_request_target")) {
      fail("B", name, "uses `pull_request_target`, which hands a fork's pull request the base branch's secrets. Use `pull_request`.");
    }

    // A — the bug this file was written for.
    if (pr) {
      const config = triggers.get("pull_request");
      const branches = config === null ? undefined : config.branches;
      const unrestricted =
        branches === undefined ||
        branches === null ||
        (Array.isArray(branches) && branches.length === 1 && branches[0] === EVERY_BRANCH);
      if (!unrestricted) {
        fail("A", name, `restricts \`pull_request\` to branches ${describe(branches)}. A pull request based on any other branch then runs no checks at all — not a failing check, none. Remove the \`branches:\` key.`);
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
