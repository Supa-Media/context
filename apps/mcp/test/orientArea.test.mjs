// `orient { area }` and `orient { for }` (`src/orient/area.js`): a bot that
// holds an area orients in that area alone, and a person's delegate in every
// area they hold (the owner, 2026-11-25). Read at the connection's own
// clearance: an area it cannot see answers exactly like one that is missing.
import test from "node:test";
import assert from "node:assert/strict";
import { toolOrient } from "../src/orient/tool.js";
import { areaSeatsSection } from "../src/orient/area.js";
import { connectedBlock } from "../src/orient/workspaces.js";
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
  "areas/engineering/about.md": { properties: { owner: "@seyi", delegate: "Pipeline", modes: ["Visionary"], approvals: ["Merging to main"] } },
  // An old helper line under a bot owner names nobody: a bot owns outright.
  "areas/support/about.md": { properties: { owner: "Finance", helper: "Pipeline" } },
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
  ["areas/support/about.md", 40],
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

test("an area's one delegate acts for its person owner, and orient for the bot lists it as delegate", async () => {
  // The owner, 2026-11-25: "1 delegate per area please"; a bot-owned area has none.
  const area = text(await toolOrient(store(), "team", RULES, OVERRIDES, { area: "areas/engineering" }));
  assert.match(area, /- Delegate: Pipeline \(acts for @seyi here/);
  const bot = text(await toolOrient(store(), "team", RULES, OVERRIDES, { for: "Pipeline" }));
  assert.match(bot, /## Engineering \(`areas\/engineering\/`\) — delegate, acting for @seyi/);
  assert.match(bot, /Needs @seyi's approval first: Merging to main/);
  assert.doesNotMatch(bot, /Support/);
  assert.doesNotMatch(text(await toolOrient(store(), "team", RULES, OVERRIDES, { area: "areas/support" })), /Delegate/);
});

test("an app that drops new arguments can ask the same with about", async () => {
  const byAbout = text(await toolOrient(store(), "team", RULES, OVERRIDES, { about: "area areas/finance" }));
  assert.match(byAbout, /^# Area: Finance/);
  const forAbout = text(await toolOrient(store(), "team", RULES, OVERRIDES, { about: "for @seyi" }));
  assert.match(forAbout, /^# Areas @seyi holds/);
});

test("the overview says who holds each area, delegate first, and to mail the area that owns a problem", async () => {
  // The owner, 2026-11-25: agents should know who can help, "like reporting a slow CI to the Devops Area", and
  // "always reach out to delegate first".
  const out = await areaSeatsSection(store(), "team", RULES, OVERRIDES);
  assert.match(out, /^Who holds each area:\n/);
  assert.match(out, /- `areas\/engineering\/` — owner @seyi, delegate Pipeline \(ask Pipeline first\) · mail `areas\/engineering\/mail\/`/);
  assert.match(out, /- `areas\/finance\/` — owner Finance · mail `areas\/finance\/mail\/`/);
  // A bot owner's old helper line names no delegate; an area with no owner line is not listed.
  assert.match(out, /- `areas\/support\/` — owner Finance · mail/);
  assert.doesNotMatch(out, /payroll|areas\/about/);
  assert.match(out, /slow CI for a DevOps area/);
  assert.match(out, /write \{ action: "mail", path, args: \{ text \} \}/);
  assert.match(out, /Its delegate is alerted first; go to its owner only when it has no delegate, or for what its approvals name/);
  // An area this connection cannot see is never named; its owner sees it.
  assert.doesNotMatch(out, /secret/);
  assert.match(await areaSeatsSection(store(), "private", RULES, OVERRIDES), /`areas\/secret\/` — owner @seyi/);
  // Said in the connected workspace's block, after its folders.
  const block = connectedBlock({ entry: null, page: null, survey: { total: 1, rootNotes: [], folders: [], recent: [], captured: [] }, areaSeats: out });
  assert.match(block, /Who holds each area:/);
});

test("no seats, or a map that cannot be read, says nothing", async () => {
  assert.equal(await areaSeatsSection({ treeEntries: async () => [{ key: "notes.md", uploaded: at(1) }], treeFacts: async () => ({ served: false }) }, "team", RULES, OVERRIDES), "");
  assert.equal(await areaSeatsSection({ treeEntries: async () => { throw new Error("down"); } }, "team", RULES, OVERRIDES), "");
  assert.equal(await areaSeatsSection({}, "team", RULES, OVERRIDES), "");
});

test("orient area lists the area's routines, its bot's budget, the other bots, and that bots talk only in mail", async () => {
  // The owner, 2026-11-25: routines are the area's and Context runs them; a bot's person caps its week per area; bots
  // talk to each other only in Context mail.
  const props = {
    ...PROPS,
    "bots/finance/about.md": { properties: { bot: "grok", holder: "Finance", belongs_to: "@seyi", works_in: ["areas/finance · 20%"] } },
    "areas/bots/pipeline/about.md": { properties: { bot: "grok", holder: "Pipeline", belongs_to: "@kim" } },
  };
  const entries = [
    ...ENTRIES,
    { key: "areas/finance/routines/weekly/close-the-books.md", uploaded: at(1) },
    { key: "areas/finance/routines/someday/maybe.md", uploaded: at(1) },
    { key: "bots/finance/about.md", uploaded: at(1) },
    { key: "areas/bots/pipeline/about.md", uploaded: at(1) },
  ];
  const base = store();
  const withBots = {
    ...base,
    treeEntries: async () => entries,
    treeFacts: async (request) =>
      request.ask === "props"
        ? { served: true, props: request.paths.filter((path) => props[path]).map((path) => ({ path, props: JSON.stringify(props[path]) })) }
        : base.treeFacts(request),
    objectBots: {
      state: async () => ({
        week: "2026-11-23",
        routines: [{ path: "areas/finance/routines/weekly/close-the-books.md", area: "areas/finance", nextAt: Date.parse("2026-11-30T14:00:00Z"), lastAt: Date.parse("2026-11-23T14:00:00Z"), outcome: "sent", answeredAt: null }],
        usage: [{ bot: "finance", area: "areas/finance", used: 12 }],
      }),
    },
  };
  const out = text(await toolOrient(withBots, "team", RULES, OVERRIDES, { area: "areas/finance" }));
  assert.match(out, /## Routines\n- areas\/finance\/routines\/weekly\/close-the-books\.md — next 2026-11-30T14:00:00Z; sent 2026-11-23T14:00:00Z, not answered yet/);
  assert.match(out, /maybe\.md — won't run: "someday" isn't a schedule/);
  assert.match(out, /a bot never sets up its own/);
  assert.match(out, /## Budget\nFinance may spend 20% of its weekly usage here; it has said it used 12% \(week of 2026-11-23\)\. 8% is left\./);
  // The routines folder is not a sub-area or a note of the area's own.
  assert.doesNotMatch(out, /routines\/about\.md/);
  assert.match(out, /Anything for another area or bot: that area.s mail, never your own app.s messages or tasks/);

  const held = text(await toolOrient(withBots, "team", RULES, OVERRIDES, { for: "Finance" }));
  assert.match(held, /Waiting for your answer: areas\/finance\/routines\/weekly\/close-the-books\.md/);
  assert.match(held, /Budget: 20% of your week; 12% used this week/);
  assert.match(held, /## Other bots here\n- Pipeline \(@kim's\)/);
  assert.doesNotMatch(held, /## Other bots here\n[^#]*- Finance \(/);
  assert.match(held, /Mail written to you outside any area is in `bots\/finance\/mail\/`/);
});
