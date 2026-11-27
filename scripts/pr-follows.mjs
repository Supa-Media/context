#!/usr/bin/env node
/**
 * Every pull request says whether it fixes something an earlier one broke or
 * missed, so the follow-up fix rate can be counted (Dev2, 2026-11-27: "a lot of
 * issues ... stem around something being changed in one note but other nodes or
 * pieces of an architecture don't have visibility into what changed"; the goal
 * is a lower bug rate after features and fixes, measured in Context;
 * docs/decisions/observability/follow-up-rate.md).
 *
 * A description carries one line:
 *
 *   Follows: none
 *   Follows: #4201 (service-contract)
 *   Follows: #4238, #4240 (incomplete)
 *
 * The kind names the hidden link the earlier pull request did not see, so the
 * rate can be split by the fix that would have prevented it.
 *
 *   node scripts/pr-follows.mjs                 # in CI: BASE_SHA, TEX_PR_BODY; fails on a missing or bad line
 *                                               # (locally, an empty description passes: precheck before the PR exists)
 *   node scripts/pr-follows.mjs --label         # on main: PR_BODY, PR (number); prints the label to set
 *   node scripts/pr-follows.mjs --self-test
 */

/** What kind of hidden link the earlier change did not see. */
export const KINDS = Object.freeze({
  "retold-rule": "a rule enforced in one place and restated by hand elsewhere (a prompt, a tool description, a check)",
  "copied-logic": "the same decision coded twice, and only one copy changed",
  "service-contract": "a message or call between two parts (Worker, gateway, bridge, app) whose other side was not changed",
  "shape-assumption": "code that relied on an order, a position or a shape the earlier change moved",
  "lab-vs-live": "the Lab, a test chat or a preview took a different path from production",
  incomplete: "the earlier change did not finish its own job (a case it missed)",
  other: "none of the above; say why in the description",
});

export const LINE = "Follows:";
/** The label a merged pull request carries, read by the GitHub data source as its `follow_up` column. */
export const LABEL_PREFIX = "follow-up:";

/** The line's verdict: `{ kind: "none" }`, `{ kind, prs }`, or `{ problem }`. */
export function readFollows(body) {
  const line = String(body ?? "")
    .split(/\r?\n/)
    .map((text) => text.trim().replace(/^[-*]\s+/, "").replace(/^\*\*(Follows:)\*\*/i, "$1"))
    .find((text) => text.toLowerCase().startsWith(LINE.toLowerCase()));
  if (line === undefined) return { problem: "missing" };
  const rest = line.slice(LINE.length).trim();
  if (/^none\b/i.test(rest)) return { kind: "none", prs: [] };
  const prs = [...rest.matchAll(/#(\d{1,7})\b/g)].map((match) => Number(match[1]));
  const kind = /\(([a-z-]+)\)/i.exec(rest)?.[1]?.toLowerCase();
  if (prs.length === 0) return { problem: `"${line}" names no pull request (#N), and is not "${LINE} none"` };
  if (!kind || !Object.hasOwn(KINDS, kind)) return { problem: `"${line}" names no kind in brackets from: ${Object.keys(KINDS).join(", ")}` };
  return { kind, prs };
}

/** The label for a description: `follow-up:none`, `follow-up:<kind>`, or `follow-up:unstated` when the line is missing or bad. */
export function labelFor(body) {
  const read = readFollows(body);
  return `${LABEL_PREFIX}${read.problem ? "unstated" : read.kind}`;
}

function howTo(problem) {
  const kinds = Object.entries(KINDS).map(([kind, meaning]) => `  ${kind}: ${meaning}`).join("\n");
  return [
    problem === "missing" ? `This pull request's description has no "${LINE}" line.` : `The "${LINE}" line is not readable: ${problem}.`,
    `Add one line: "${LINE} none", or "${LINE} #N (kind)" when this fixes something pull request #N broke or missed.`,
    "Kinds:",
    kinds,
    "It counts the follow-up fix rate (docs/decisions/observability/follow-up-rate.md). Editing the description re-runs this check.",
  ].join("\n");
}

function selfTest() {
  const cases = [
    ["none", readFollows("Why\n\nFollows: none\n").kind === "none"],
    ["none with a reason", readFollows("Follows: none (new feature)").kind === "none"],
    ["one pull request and a kind", readFollows("Follows: #4201 (service-contract)").kind === "service-contract"],
    ["several pull requests", readFollows("Follows: #4238, #4240 (incomplete)").prs.join() === "4238,4240"],
    ["a bullet and bold", readFollows("- **Follows:** #12 (retold-rule)").kind === "retold-rule"],
    ["case of the word", readFollows("follows: NONE").kind === "none"],
    ["missing", readFollows("Why\nsince #4201 this broke").problem === "missing"],
    ["no number", typeof readFollows("Follows: the Reach work (retold-rule)").problem === "string"],
    ["no kind", typeof readFollows("Follows: #4201").problem === "string"],
    ["an unknown kind", typeof readFollows("Follows: #4201 (oops)").problem === "string"],
    ["label for a kind", labelFor("Follows: #1 (lab-vs-live)") === "follow-up:lab-vs-live"],
    ["label for none", labelFor("Follows: none") === "follow-up:none"],
    ["label for a missing line", labelFor("") === "follow-up:unstated"],
    ["the first line wins", readFollows("Follows: none\nFollows: #3 (other)").kind === "none"],
  ];
  let failed = 0;
  for (const [name, good] of cases) {
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
  }
  if (failed) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--label")) process.stdout.write(labelFor(process.env.PR_BODY ?? ""));
  else {
    const { BASE_SHA, TEX_PR_BODY = "" } = process.env;
    if (!BASE_SHA) {
      console.log("pr-follows: not a pull request (no BASE_SHA); nothing to check.");
      process.exit(0);
    }
    if (TEX_PR_BODY.trim() === "" && process.env.GITHUB_ACTIONS !== "true") {
      // precheck before a pull request exists: no description to read yet, and CI reads the real one.
      console.log(`pr-follows: no description yet; CI will need a "${LINE}" line.`);
      process.exit(0);
    }
    const read = readFollows(TEX_PR_BODY);
    if (read.problem) {
      const text = howTo(read.problem);
      console.error(`::error::${text.split("\n")[0]}`);
      console.error(text);
      process.exit(1);
    }
    console.log(`pr-follows: ${read.kind === "none" ? "follows none" : `follows ${read.prs.map((n) => `#${n}`).join(", ")} (${read.kind})`}.`);
  }
}
