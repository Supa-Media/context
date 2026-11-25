// `orient { area }` and `orient { for }` (`src/orient/area.js`): a bot that
// holds an area orients in that area alone, and a person's delegate in every
// area they hold (the owner, 2026-11-25). Read at the connection's own
// clearance: an area it cannot see answers exactly like one that is missing.
import test from "node:test";
import assert from "node:assert/strict";
import { toolOrient } from "../src/orient/tool.js";
import { parsePrivacyManifest } from "../src/privacy/engine.js";

const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR);

const PROPS = {
  "areas/about.md": { properties: { agents: ["Finance"] } },
  "areas/finance/about.md": {
    properties: { owner: "Finance", modes: ["Manager", "Doer"], metrics: ["Monthly cost · target under $600"], approvals: ["Spending over $20 needs the owner's approval."] },
    lede: "Keeps the company's spending in check.",
  },
  "areas/finance/payroll/about.md": { properties: { metrics: ["Payroll on time"] } },
  "areas/engineering/about.md": { properties: { owner: "@seyi", modes: ["Visionary"] } },
  "areas/secret/about.md": { properties: { owner: "@seyi" } },
  "projects/budget-2027/about.md": { properties: { area: "areas/finance", status: "In progress", owner: "@seyi" } },
  "projects/payroll-run/about.md": { properties: { area: "Areas/Finance/Payroll/", status: "Not started" } },
  "projects/old-audit/about.md": { properties: { area: "areas/finance", status: "Done" } },
  "projects/secret-deal/about.md": { properties: { area: "areas/finance", status: "In progress" } },
  "projects/finance-x/about.md": { properties: { area: "areas/financeX", status: "In progress" } },
  "projects/website/about.md": { properties: { area: "areas/engineering" } },
};

const ENTRIES = [
  ["areas/about.md", 50],
  ["areas/finance/about.md", 40],
  ["areas/finance/grok-usage-log.md", 1],
  ["areas/finance/budget.md", 5],
  ["areas/finance/payroll/about.md", 30],
  ["areas/finance/mail/seyi.md", 2],
  ["areas/finance/mail/pipeline.md", 3],
  ["areas/engineering/about.md", 40],
  ["areas/secret/about.md", 40],
  ["areas/secret/plan.md", 40],
  ["projects/budget-2027/about.md", 10],
  ["projects/website/about.md", 10],
  ["projects/payroll-run/about.md", 10],
  ["projects/old-audit/about.md", 10],
  ["projects/secret-deal/about.md", 10],
  ["projects/finance-x/about.md", 10],
].map(([key, hours]) => ({ key, uploaded: at(hours) }));

function store() {
  return {
    treeEntries: async () => ENTRIES,
    treeFacts: async (request) => {
      if (request.ask === "jobs") return { served: true, jobs: { areas: "areas", projects: "projects" }, roots: ["areas", "projects"] };
      if (request.ask === "props") {
        return {
          served: true,
          props: request.paths.filter((path) => PROPS[path]).map((path) => ({ path, props: JSON.stringify(PROPS[path]) })),
        };
      }
      return { served: false };
    },
  };
}

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\n" +
  "default_visibility: private\n\nfolder_defaults:\n  areas: team\n  projects: team\n  projects/secret-deal: private\n  areas/secret: private\n\nnote_overrides:\n  # none\n" +
  "```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const { rules: RULES, overrides: OVERRIDES } = parsePrivacyManifest(MANIFEST);
const text = (result) => result.content.map((part) => part.text).join("\n");

test("orient area names the seat, what its modes ask, its notes, mail, projects and where to write", async () => {
  const result = await toolOrient(store(), "team", RULES, OVERRIDES, { area: "areas/finance" });
  assert.equal(result.isError, undefined);
  const out = text(result);
  assert.match(out, /^# Area: Finance \(`areas\/finance\/`\)/);
  assert.match(out, /Keeps the company's spending in check\./);
  assert.match(out, /- Owner: Finance\n/);
  assert.match(out, /- Modes: Manager, Doer/);
  assert.match(out, /- Metric: Monthly cost · target under \$600/);
  assert.match(out, /Spending over \$20 needs the owner's approval\./);
  assert.match(out, /- Manager: Makes sure the work gets done at high quality/);
  assert.match(out, /Visionary is not yours here/);
  // Newest note first; mail and the seat itself are not listed as notes.
  const notes = out.slice(out.indexOf("## Notes in this area"), out.indexOf("## Sub-areas"));
  assert.ok(notes.indexOf("grok-usage-log.md") < notes.indexOf("budget.md"));
  assert.doesNotMatch(notes, /mail\/seyi\.md|about\.md/);
  assert.match(out, /- areas\/finance\/payroll\/ — orient \{ area: "areas\/finance\/payroll" \}/);
  assert.match(out, /## Mail\n- areas\/finance\/mail\/seyi\.md[\s\S]*- areas\/finance\/mail\/pipeline\.md/);
  // In progress first, with counts by group; a sub-area's project is counted and says which it serves.
  const projects = out.slice(out.indexOf("## Projects attached"), out.indexOf("## Where to write"));
  assert.match(projects, /## Projects attached to this area\n1 in progress, 1 not started, 1 done\.\n- projects\/budget-2027\/ — In progress, @seyi\n/);
  assert.match(projects, /- projects\/payroll-run\/ — Not started, serves Areas\/Finance\/Payroll\n- projects\/old-audit\/ — Done/);
  // Another area, a sibling whose name only starts the same, and a project this connection cannot see are never listed.
  assert.doesNotMatch(projects, /projects\/website|finance-x|secret-deal/);
  assert.match(projects, /manage \{ action: "area", args: \{ area: "areas\/finance", attach: "projects\/<name>" \} \}/);
  assert.match(out, /New projects: `projects\/<name>\/`, with `area: areas\/finance`/);
});

test("the owner, who can see the private project, has it counted", async () => {
  const out = text(await toolOrient(store(), "private", RULES, OVERRIDES, { area: "areas/finance" }));
  assert.match(out, /2 in progress, 1 not started, 1 done\./);
  assert.match(out, /projects\/secret-deal\//);
});

test("a sub-area with no owner of its own says whose it is through the area above", async () => {
  const out = text(await toolOrient(store(), "team", RULES, OVERRIDES, { area: "areas/finance/payroll/" }));
  assert.match(out, /- Owner: Finance \(held through areas\/finance\)/);
});

test("an area this connection cannot see answers exactly like one that does not exist", async () => {
  const hidden = await toolOrient(store(), "team", RULES, OVERRIDES, { area: "areas/secret" });
  const missing = await toolOrient(store(), "team", RULES, OVERRIDES, { area: "areas/nothing" });
  assert.equal(hidden.isError, true);
  assert.equal(text(hidden).replace("areas/secret", "X"), text(missing).replace("areas/nothing", "X"));
  // The owner sees it.
  assert.equal((await toolOrient(store(), "private", RULES, OVERRIDES, { area: "areas/secret" })).isError, undefined);
});

test("orient for lists every area a person holds, with modes, and never one the connection cannot see", async () => {
  const out = text(await toolOrient(store(), "team", RULES, OVERRIDES, { for: "seyi" }));
  assert.match(out, /^# Areas seyi holds/);
  assert.match(out, /## Engineering \(`areas\/engineering\/`\) — owner\n- Modes: Visionary/);
  assert.doesNotMatch(out, /secret/i);
  assert.match(out, /- Visionary: Sets the direction/);
  const bot = text(await toolOrient(store(), "team", RULES, OVERRIDES, { for: "Finance" }));
  assert.match(bot, /## Finance \(`areas\/finance\/`\) — owner/);
  assert.doesNotMatch(bot, /Payroll/);
});

test("an app that drops new arguments can ask the same with about", async () => {
  const byAbout = text(await toolOrient(store(), "team", RULES, OVERRIDES, { about: "area areas/finance" }));
  assert.match(byAbout, /^# Area: Finance/);
  const forAbout = text(await toolOrient(store(), "team", RULES, OVERRIDES, { about: "for @seyi" }));
  assert.match(forAbout, /^# Areas @seyi holds/);
});
