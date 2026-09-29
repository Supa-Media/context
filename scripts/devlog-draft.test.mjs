/**
 * The Monday draft is the owner's starting point: the page's exact format,
 * shipped from production only, the other three sections carried from the
 * published week, and no write permission anywhere.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in
 * this file.
 *
 *   `selectWeekRuns` counting a failed or automatic run as production      1
 *   `buildDraft` not carrying in progress / exploring / declined           1
 *   `renderWeekMarkdown` dropping the exploring disclaimer line            2
 *   the draft workflow granted `contents: write`                           1
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readFileSync as read } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEVLOG_EXPLORING_DISCLAIMER, parseDevlog } from "../packages/shared/src/devlog.ts";
import { buildDraft, draftWindow, publishedDevlog, renderDraftSummary } from "./devlog-copy.mjs";
import { main, selectWeekRuns } from "./devlog-draft.mjs";

const sha = (character) => character.repeat(40);
const run = (overrides = {}) => ({
  id: 42,
  name: "Deploy to Production",
  path: ".github/workflows/deploy-production.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: sha("b"),
  run_number: 12,
  html_url: "https://github.example/actions/runs/42",
  updated_at: "2026-10-01T12:00:00Z",
  ...overrides,
});

const PUBLISHED = `# devlog

### week 12
*september 21 to 27, 2026*

#### shipped
- search that finds the note you meant

#### in progress
- sharing a folder by link

#### exploring
*${DEVLOG_EXPLORING_DISCLAIMER}*
- looking at: a calendar view

#### declined
- a public profile page. share a folder by link instead.

### week 11
- the old single list
`;
const snapshot = (markdown = PUBLISHED) => ({
  siteName: "context",
  revision: "rev-1",
  pages: [
    { path: "index.md", routePath: "/", title: "home", markdown: "# hi" },
    { path: "devlog.md", routePath: "/devlog", title: "devlog", markdown },
  ],
});
const commit = (character, subject, pullRequest) => ({
  sha: sha(character),
  committedAt: "2026-10-01T10:00:00Z",
  subject,
  pullRequest,
});
const WINDOW = draftWindow(new Date("2026-10-05T13:00:00Z"));

test("a Monday run covers the seven days before it, named as the page names them", () => {
  assert.equal(WINDOW.dates, "september 28 to october 4, 2026");
  assert.equal(draftWindow(new Date("2027-01-04T13:00:00Z")).dates, "december 28, 2026 to january 3, 2027");
});

test("production runs in the window define shipped, from the last production head before it", () => {
  const before = run({ id: 40, run_number: 10, head_sha: sha("a"), updated_at: "2026-09-27T09:00:00Z" });
  const first = run({ id: 41, run_number: 11, head_sha: sha("c"), updated_at: "2026-09-29T09:00:00Z" });
  const newest = run({ id: 43, run_number: 13, head_sha: sha("d"), updated_at: "2026-10-03T09:00:00Z" });
  const runs = [
    run({ id: 44, run_number: 14, head_sha: sha("e"), updated_at: "2026-10-06T09:00:00Z" }),
    newest,
    run({ id: 42, run_number: 12, conclusion: "failure", head_sha: sha("f"), updated_at: "2026-10-02T09:00:00Z" }),
    run({ id: 45, run_number: 15, event: "push", head_sha: sha("9"), updated_at: "2026-10-02T09:00:00Z" }),
    first,
    before,
  ];
  const selected = selectWeekRuns(runs, WINDOW);
  assert.deepEqual(selected.runs.map((candidate) => candidate.id), [41, 43]);
  assert.deepEqual(selected.interval, { from: sha("a"), to: sha("d") });
  assert.deepEqual(selectWeekRuns([before], WINDOW), { runs: [], interval: null });
});

test("the draft parses back as one week with the right sections, carrying the published three", () => {
  const draft = buildDraft({
    published: publishedDevlog(snapshot()),
    dates: WINDOW.dates,
    commits: [
      commit("1", "Add safe multi-workspace route suggestions (#1109)", 1109),
      commit("2", "Hotfix straight to main", null),
      commit("3", "MCP tool names match the docs (#1110)", 1110),
    ],
  });
  const [week, ...rest] = parseDevlog(draft.markdown);
  assert.equal(rest.length, 0);
  assert.equal(week.number, 13);
  assert.equal(week.dates, "september 28 to october 4, 2026");
  assert.equal(week.sectioned, true);
  assert.equal(week.exploringDisclaimed, true);
  assert.deepEqual(week.sections.shipped, [
    "add safe multi-workspace route suggestions (#1109)",
    "MCP tool names match the docs (#1110)",
  ]);
  assert.deepEqual(week.sections.inProgress, ["sharing a folder by link"]);
  assert.deepEqual(week.sections.exploring, ["looking at: a calendar view"]);
  assert.deepEqual(week.sections.declined, ["a public profile page. share a folder by link instead."]);
  assert.deepEqual(draft.direct.map((entry) => entry.subject), ["Hotfix straight to main"]);
  assert.equal(draft.note, null);
  assert.equal(
    draft.markdown,
    [
      "### week 13",
      "*september 28 to october 4, 2026*",
      "",
      "#### shipped",
      "- add safe multi-workspace route suggestions (#1109)",
      "- MCP tool names match the docs (#1110)",
      "",
      "#### in progress",
      "- sharing a folder by link",
      "",
      "#### exploring",
      "*ideas, not promises. some of these won't happen.*",
      "- looking at: a calendar view",
      "",
      "#### declined",
      "- a public profile page. share a folder by link instead.",
      "",
    ].join("\n"),
  );
});

test("without a published page the number is N, nothing is carried, and the summary says why", () => {
  const draft = buildDraft({ published: null, readError: "DEVLOG_CONVEX_URL is not set", dates: WINDOW.dates, commits: [] });
  assert.match(draft.markdown, /^### week N\n/);
  assert.equal(parseDevlog(draft.markdown).length, 0, "a placeholder cannot be mistaken for a real week");
  assert.match(draft.markdown, /#### in progress\n\n#### exploring\n\*ideas, not promises\. some of these won't happen\.\*\n\n#### declined\n$/);
  assert.match(draft.note, /could not be read \(DEVLOG_CONVEX_URL is not set\)/);
  const summary = renderDraftSummary({ draft, runs: [], interval: null });
  assert.match(summary, /No production promotion completed/);
  assert.match(summary, /could not be read/);
  assert.match(summary, /Nothing was written to the devlog, no release was created, and nothing was posted\./);
});

test("the summary tells the owner the numbers are for them, not the page", () => {
  const draft = buildDraft({
    published: publishedDevlog(snapshot()),
    dates: WINDOW.dates,
    commits: [commit("1", "Add a thing (#7)", 7)],
  });
  const summary = renderDraftSummary({
    draft,
    runs: [run()],
    interval: { from: sha("a"), to: sha("b") },
  });
  assert.match(summary, /remove the \(#123\) numbers on the page/);
  assert.match(summary, /copied from week 12 as published/);
  assert.ok(summary.includes(draft.markdown.trimEnd()));
});

test("main reads production and the page, writes the artifact, and posts nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devlog-draft-"));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method });
    return new Response(JSON.stringify({ status: "success", value: snapshot() }));
  };
  const { draft } = await main({
    env: {
      GITHUB_REPOSITORY: "example/context",
      DEVLOG_CONVEX_URL: "https://convex.example",
      DEVLOG_DRAFT_PATH: join(dir, "week.md"),
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    },
    now: new Date("2026-10-05T13:00:00Z"),
    fetchImpl,
    listRuns: async () => [
      run({ id: 40, run_number: 10, head_sha: sha("a"), updated_at: "2026-09-20T09:00:00Z" }),
      run({ id: 41, run_number: 11, head_sha: sha("c"), updated_at: "2026-10-01T09:00:00Z" }),
    ],
    commitsBetween: (from, to) => {
      assert.deepEqual([from, to], [sha("a"), sha("c")]);
      return [commit("1", "Add a thing (#7)", 7)];
    },
  });
  assert.equal(draft.number, 13);
  assert.equal(read(join(dir, "week.md"), "utf8"), draft.markdown);
  assert.match(read(join(dir, "summary.md"), "utf8"), /Devlog draft · week 13/);
  assert.deepEqual(calls, [{ url: "https://convex.example/api/action", method: "POST" }]);
});

test("the draft workflow reads on a Monday and has no way to write", () => {
  const workflow = readFileSync(new URL("../.github/workflows/devlog-draft.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "0 13 \* \* 1"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read\n\n/);
  assert.match(workflow, /DEVLOG_CONVEX_URL: \$\{\{ vars\.DEVLOG_CONVEX_URL \}\}/);
  assert.doesNotMatch(workflow, /:\s*write|secrets\.|gh\s+release|release\s+create|wrangler/i);
});
