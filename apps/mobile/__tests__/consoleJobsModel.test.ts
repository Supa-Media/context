/**
 * The staff console's Jobs page model (`features/admin/console/pages/jobs/jobsModel.ts`):
 * the list rows, a job's head, its cases, its setups, its runs, Compare, and
 * the activity feed. Every fixture is fake: the `ai/` notes and scores notes
 * are built here, and read the way the app reads them.
 */

import { describe, expect, test } from "@jest/globals";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";
import { jobPage, readRun, type Candidate, type JobPage, type RunRead, type SetupStatus } from "../features/admin/aiModel";
import { parseReplies } from "../features/admin/aiCompareModel";
import {
  ago,
  activityRows,
  caseGroups,
  caseId,
  casesOf,
  chanceBetter,
  compareView,
  dayLabel,
  filterActivity,
  jobCases,
  jobHead,
  jobList,
  runRows,
  setupRows,
  vsOf,
  type CaseCard,
} from "../features/admin/console/pages/jobs/jobsModel";
import { parseTestList } from "../features/admin/testList";

// ---------------------------------------------------------------------------
// Fixtures

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Saturday 14 November 2026, noon, local time: the page's "now". */
const NOW = new Date(2026, 10, 14, 12, 0).getTime();

const GH_410 = "ai/results/2026-11-09 heartbeat gh-410 scores.md";
const GH_411 = "ai/results/2026-11-10 heartbeat gh-411 scores.md";
const GH_412 = "ai/results/2026-11-12 heartbeat gh-412 scores.md";
const PRODUCTION_HEARTBEAT = "ai/production/heartbeat.md";

const CASE_TITLES = [
  "Quiet when nothing changed",
  "Quiet on a weekend",
  "Speaks up about a new invoice",
  "Stays quiet after a no-reply",
  "Morning look, no new mail",
  "Evening wrap-up with nothing to say",
  "Reminds about a dentist booking",
  "Quiet during a meeting",
  "Quiet after dark",
  "Notes a missed delivery",
  "Asks before texting a new person",
  "Mentions a flight change",
  "Checks in after a long silence",
  "Says nothing about a finished task",
];

const TEST_LIST = [
  "---",
  "job: heartbeat",
  "---",
  "",
  "# Staying quiet",
  "",
  "## 1. Quiet when nothing changed",
  "",
  "Morning look, no new mail",
  "",
  "- must not: text them",
  "- may: write a heartbeat note",
  "",
].join("\n");

/** A `ai/` note as `folderNotes` answers it. */
const note = (path: string, properties: Record<string, unknown> = {}, updatedAt?: number): FolderNote => ({
  path,
  props: JSON.stringify({ properties, heading: "", lede: "" }),
  ...(updatedAt === undefined ? {} : { updatedAt }),
});

interface SetupLine {
  setup: string;
  pct: number;
  gates: string;
  good: boolean;
}

/** A scores note, the way the bench writes one: a "## Scored by" table of nine columns, the misses, and the case-by-case grid. */
function scoresNote(opts: { day: string; setups: SetupLine[]; misses?: string[]; grid?: { title: string; cells: Record<string, string> }[] }): string {
  const names = opts.setups.map((row) => row.setup);
  const lines = [
    `# Heartbeat round, ${opts.day}`,
    "",
    `## Scored by judge-model, ${opts.day}`,
    "",
    "| setup | score | gates | judge | price | speed | texts | errors | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...opts.setups.map((row) => `| ${row.setup} | ${row.pct}% | ${row.gates} | 2 of 2 judged | $0.03 | 3.1 s | 12 | 0 | ${row.good ? "yes" : "no"} |`),
    "",
  ];
  if (opts.misses && opts.misses.length > 0) lines.push("Why gates failed, production:", ...opts.misses, "");
  if (opts.grid) {
    lines.push(
      "### Case by case",
      "",
      `| case | ${names.join(" | ")} |`,
      `| --- | ${names.map(() => "---").join(" | ")} |`,
      ...opts.grid.map((item, index) => `| ${index + 1}. ${item.title} | ${names.map((name) => item.cells[name]).join(" | ")} |`),
      "",
    );
  }
  return lines.join("\n");
}

/** The round of gh-412: live (named `production`) passed 30 of 42; quiet-mornings passed 40 of 42. */
function gh412Text(quietGates: string): string {
  return scoresNote({
    day: "2026-11-12",
    setups: [
      { setup: "production", pct: 71, gates: "failed (q11, q12, q13, q14)", good: false },
      { setup: "quiet-mornings", pct: 95, gates: quietGates, good: quietGates === "passed" },
    ],
    misses: ["- q11 must say Tuesday: 0 of 3", "- q12 must not text them: 0 of 3", "- q13 must say Tuesday: 0 of 3", "- q14 must not text them: 0 of 3"],
    grid: CASE_TITLES.map((title, index) => ({
      title,
      cells: {
        production: index < 10 ? "3 of 3" : "0 of 3",
        "quiet-mornings": index < 12 ? "3 of 3" : "2 of 3",
      },
    })),
  });
}

const GH_410_TEXT = scoresNote({ day: "2026-11-09", setups: [{ setup: "production", pct: 100, gates: "passed", good: true }] });

function baseNotes(): FolderNote[] {
  return [
    note(PRODUCTION_HEARTBEAT, { from: "checkin-v7", live_since: "2026-11-06", promoted_by: "seyi" }, new Date(2026, 10, 6, 8, 0).getTime()),
    note("ai/tests/heartbeat.md", { job: "heartbeat" }),
    note("ai/setups/heartbeat/quiet-mornings.md", { job: "heartbeat", change: "Stay quiet when nothing changed", made_by: "Improver" }, new Date(2026, 10, 13, 18, 30).getTime()),
    note("ai/setups/heartbeat/gentler-evenings.md", { job: "heartbeat", change: "Shorter evening check", made_by: "Claude" }),
    note(GH_410, {}, new Date(2026, 10, 9, 10, 0).getTime()),
    note(GH_411, {}, new Date(2026, 10, 10, 10, 0).getTime()),
    note(GH_412, {}, NOW - 3 * HOUR),
    note("ai/production/texting-assistant.md", { from: "tex-v3", live_since: "2026-10-30", promoted_by: "seyi" }),
    note("ai/setups/texting-assistant/tex-shorter.md", { job: "texting-assistant", change: "Shorter replies", made_by: "Improver" }),
  ];
}

/** Reads the scores notes that were read; GH_411 is left unread, so its run is still running. */
function readsFor(texts: Record<string, string>): Map<string, RunRead> {
  const reads = new Map<string, RunRead>();
  for (const [path, raw] of Object.entries(texts)) {
    const read = readRun(raw);
    if (read !== null) reads.set(path, read);
  }
  return reads;
}

function fixture(options: { quietGates?: string; extra?: FolderNote[]; drop?: string[] } = {}) {
  const { quietGates = "passed", extra = [], drop = [] } = options;
  const notes = [...baseNotes().filter((item) => !drop.includes(item.path)), ...extra];
  const catalog = buildCatalog(notes);
  const reads = readsFor({ [GH_410]: GH_410_TEXT, [GH_412]: gh412Text(quietGates) });
  const page = jobPage(catalog, "heartbeat", reads)!;
  return { catalog, reads, page };
}

const candidateOf = (page: JobPage, name: string): Candidate => page.candidates.find((item) => item.name === name)!;

// ---------------------------------------------------------------------------

describe("dayLabel and ago", () => {
  test("a day reads as its month and day, without the year", () => {
    expect(dayLabel("2026-11-06")).toBe("Nov 6");
    expect(dayLabel("2026-01-20")).toBe("Jan 20");
    expect(dayLabel(null)).toBeNull();
  });

  test("ago buckets a time into just now, minutes, hours and days", () => {
    expect(ago(NOW, NOW)).toBe("just now");
    expect(ago(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
    expect(ago(NOW - 3 * HOUR, NOW)).toBe("3h ago");
    expect(ago(NOW - 2 * 24 * HOUR, NOW)).toBe("2d ago");
    expect(ago(null, NOW)).toBeNull();
  });
});

describe("jobList", () => {
  test("Tex's row is first, links to the Lab, and every job comes in catalog order", () => {
    const { catalog, reads } = fixture();
    const rows = jobList(catalog, reads, NOW);
    expect(rows.map((row) => row.key)).toEqual([
      "texting-assistant",
      "connected-ais",
      "dream",
      "heartbeat",
      "housekeeping",
      "meeting-transcription",
      "meeting-summaries",
      "search",
    ]);
    expect(rows[0]).toEqual({ key: "texting-assistant", name: "Tex, by text", lab: true, live: null, score: null, trend: [], last: null, cand: false, next: null });
  });

  test("a job with a live setup, a score, a trend and a beating candidate", () => {
    const { catalog, reads } = fixture();
    const row = jobList(catalog, reads, NOW).find((item) => item.key === "heartbeat")!;
    expect(row).toEqual({
      key: "heartbeat",
      name: "Check-in",
      lab: false,
      live: "checkin-v7",
      score: 71,
      trend: [100, 71],
      last: "3h ago",
      cand: true,
      next: null,
    });
  });

  test("a job with no tests asks for its first test", () => {
    const { catalog, reads } = fixture();
    const row = jobList(catalog, reads, NOW).find((item) => item.key === "dream")!;
    expect(row).toMatchObject({ live: null, score: null, trend: [], last: null, cand: false, next: "Write its first test" });
  });

  test("a job with no setup note shows the model it runs on", () => {
    const { catalog, reads } = fixture();
    const row = jobList(catalog, reads, NOW).find((item) => item.key === "meeting-transcription")!;
    expect(row.live).toBe("Whisper");
  });
});

describe("jobHead", () => {
  test("says since when and by whom, the checks, the cost and the speed", () => {
    const { page } = fixture();
    expect(jobHead(page)).toMatchObject({
      live: "checkin-v7",
      since: "since Nov 6 · by seyi",
      score: "71%",
      checks: "30 of 42 checks pass",
      costSpeed: "$0.03 · 3.1 s",
      trend: [100, 71],
    });
  });

  test("with nothing live the head says so", () => {
    const { page } = fixture({ drop: [PRODUCTION_HEARTBEAT] });
    expect(jobHead(page).live).toBe("nothing live");
  });
});

// ---------------------------------------------------------------------------

describe("cases", () => {
  test("a case id keeps letters, digits and hyphens and turns anything else into a hyphen", () => {
    expect(caseId("heartbeat", 1)).toBe("heartbeat-1");
    expect(caseId("texting assistant/v2_x", 3)).toBe("texting-assistant-v2-x-3");
  });

  test("a test list's case reads its id, when, rules and group", () => {
    const cases = casesOf({ name: "heartbeat", title: "Check-in", path: "ai/tests/heartbeat.md" }, parseTestList(TEST_LIST));
    expect(cases).toEqual([
      {
        id: "heartbeat-1",
        path: "ai/tests/heartbeat.md",
        test: "heartbeat",
        number: 1,
        name: "Quiet when nothing changed",
        when: "Morning look, no new mail",
        rules: [
          { index: 10, kind: "must not", text: "text them" },
          { index: 11, kind: "may", text: "write a heartbeat note" },
        ],
        group: "Staying quiet",
      },
    ]);
  });

  test("a list with no heading is grouped under its test's title", () => {
    const list = parseTestList("## 1. Tidy the inbox\n\n- must: file it\n");
    const cases = casesOf({ name: "housekeeping", title: "Housekeeping tidy", path: "ai/tests/housekeeping.md" }, list);
    expect(cases[0]!.group).toBe("Housekeeping tidy");
    expect(cases[0]!.rules).toEqual([{ index: 2, kind: "must", text: "file it" }]);
  });

  test("jobCases reads every test list the job owns, and skips a list whose text is not read", () => {
    const tests = [
      { name: "heartbeat", title: "Check-in", path: "ai/tests/heartbeat.md" },
      { name: "heartbeat-extra", title: "Extra", path: "ai/tests/heartbeat-extra.md" },
    ];
    const texts = new Map<string, string | null>([
      ["ai/tests/heartbeat.md", TEST_LIST],
      ["ai/tests/heartbeat-extra.md", null],
    ]);
    const cases = jobCases(tests, texts);
    expect(cases.map((item) => item.id)).toEqual(["heartbeat-1"]);
  });

  test("caseGroups keeps the lists' order and merges cases whose lists share a name", () => {
    const cases: CaseCard[] = [
      ...casesOf({ name: "heartbeat", title: "Check-in", path: "ai/tests/heartbeat.md" }, parseTestList(TEST_LIST)),
      ...casesOf({ name: "weekend", title: "Weekend", path: "ai/tests/weekend.md" }, parseTestList("# Weekends\n\n## 1. Quiet on Saturday\n\n- must not: text them\n")),
      ...casesOf({ name: "heartbeat-2", title: "More", path: "ai/tests/heartbeat-2.md" }, parseTestList("# Staying quiet\n\n## 2. Morning look\n\n- may: say nothing\n")),
    ];
    const groups = caseGroups(cases);
    expect(groups.map((entry) => entry.group)).toEqual(["Staying quiet", "Weekends"]);
    expect(groups[0]!.cases.map((item) => item.id)).toEqual(["heartbeat-1", "heartbeat-2-2"]);
    expect(groups[1]!.cases.map((item) => item.id)).toEqual(["weekend-1"]);
  });
});

// ---------------------------------------------------------------------------

describe("setups", () => {
  test("vsOf names every setup status", () => {
    const expected: [SetupStatus, string, string][] = [
      ["live", "Live", "ok"],
      ["beat live", "Better", "ok"],
      ["lost", "Worse", "bad"],
      ["too close", "Too close to call", ""],
      ["tied", "Too close to call", ""],
      ["draft", "Draft", ""],
      ["retired", "Retired", ""],
      ["not run", "Not run yet", ""],
    ];
    for (const [status, vs, tone] of expected) expect(vsOf(status)).toEqual({ vs, tone });
  });

  test("live comes first, then the setups being tried, with the live row's score and canCompare", () => {
    const { page } = fixture();
    const rows = setupRows(page);
    expect(rows.map((row) => row.name)).toEqual(["checkin-v7", "quiet-mornings", "gentler-evenings"]);
    expect(rows[0]).toEqual({ name: "checkin-v7", path: PRODUCTION_HEARTBEAT, change: null, passed: "30/42", vs: "Live", tone: "ok", live: true, canCompare: false });
    expect(rows[1]).toMatchObject({ vs: "Better", tone: "ok", passed: "40/42", live: false, canCompare: true, change: "Stay quiet when nothing changed" });
    expect(rows[2]).toMatchObject({ vs: "Not run yet", passed: "—", canCompare: true });
  });

  test("when a setup note is live, its row stands for live and no production row is added", () => {
    const { page } = fixture({
      extra: [note("ai/setups/heartbeat/checkin-v7.md", { job: "heartbeat", status: "live" })],
    });
    const rows = setupRows(page);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ name: "checkin-v7", path: "ai/setups/heartbeat/checkin-v7.md", live: true, canCompare: false, vs: "Live" });
  });

  test("a retired setup cannot be compared, and a production row is added first when nothing is live", () => {
    const { page } = fixture();
    const quiet = candidateOf(page, "quiet-mornings");
    const rows = setupRows({ ...page, candidates: [{ ...quiet, status: "retired" }] });
    expect(rows.map((row) => row.name)).toEqual(["checkin-v7", "quiet-mornings"]);
    expect(rows[0]).toMatchObject({ live: true, canCompare: false });
    expect(rows[1]).toMatchObject({ live: false, canCompare: false, vs: "Retired" });
  });
});

// ---------------------------------------------------------------------------

describe("runs", () => {
  test("runs are newest first, with a run whose scores are not read still running", () => {
    const { page } = fixture();
    const rows = runRows(page);
    expect(rows.map((row) => row.name)).toEqual(["heartbeat gh-412", "heartbeat gh-411", "heartbeat gh-410"]);
    expect(rows[0]).toEqual({ path: GH_412, name: "heartbeat gh-412", day: "Nov 12", live: "71%", best: "quiet-mornings 95%", bars: "failed" });
    expect(rows[1]).toEqual({ path: GH_411, name: "heartbeat gh-411", day: "Nov 10", live: "…", best: "…", bars: "running" });
    expect(rows[2]).toEqual({ path: GH_410, name: "heartbeat gh-410", day: "Nov 9", live: "100%", best: "—", bars: "passed" });
  });
});

// ---------------------------------------------------------------------------

describe("chanceBetter", () => {
  test("equal counts are a coin toss", () => {
    expect(chanceBetter({ passed: 20, runs: 42 }, { passed: 20, runs: 42 })).toBeCloseTo(0.5, 5);
  });

  test("a much better setup is very likely better", () => {
    expect(chanceBetter({ passed: 40, runs: 42 }, { passed: 20, runs: 42 })).toBeGreaterThan(0.9);
  });

  test("a much worse setup is very unlikely to be better", () => {
    expect(chanceBetter({ passed: 20, runs: 42 }, { passed: 40, runs: 42 })).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------

const REPLIES = [
  "# heartbeat, 2026-11-12: replies that differ",
  "",
  "## 11. Asks before texting a new person",
  "",
  "### production · run 2 of 3 · failed",
  "",
  "- missed must say Tuesday",
  "> Person: Anything new this morning?",
  "> Reply: Nothing new. Want me to text Sam?",
  "",
  "### quiet-mornings · run 1 of 3 · passed",
  "",
  "> Person: Anything new this morning?",
  "> Reply: ",
  "",
].join("\n");

describe("compareView", () => {
  test("a candidate that beats live on every case group reads as a go", () => {
    const { page } = fixture();
    const view = compareView(page, candidateOf(page, "quiet-mornings"), parseReplies(REPLIES));
    expect(view).toMatchObject({
      liveName: "checkin-v7",
      livePassed: "30/42",
      name: "quiet-mornings",
      passed: "40/42",
      vs: "Better",
      tone: "ok",
      sureDetail: "42 runs each",
      canGoLive: true,
      blocked: null,
    });
    expect(view.sure).toMatch(/^\d{1,3}%$/);
    expect(Number(view.sure.slice(0, -1))).toBeGreaterThan(90);
  });

  test("differ lists only the cases whose pass rate differs, with who missed and the rule", () => {
    const { page } = fixture();
    const view = compareView(page, candidateOf(page, "quiet-mornings"), null);
    expect(view.differ.map((item) => item.question)).toEqual([11, 12, 13, 14]);
    expect(view.differ.every((item) => item.missedBy === "live")).toBe(true);
    expect(view.differ[0]).toEqual({
      question: 11,
      title: "Asks before texting a new person",
      missedBy: "live",
      rule: "must say Tuesday",
      liveReply: null,
      setupReply: null,
    });
  });

  test("the replies on a differing case are shown for live and for the candidate", () => {
    const { page } = fixture();
    const view = compareView(page, candidateOf(page, "quiet-mornings"), parseReplies(REPLIES));
    expect(view.differ[0]).toMatchObject({
      liveReply: "Nothing new. Want me to text Sam?",
      setupReply: "(stays quiet)",
    });
  });

  test("Make it live is off, with the failing gate named, when a case group failed a gate on the candidate", () => {
    const { page } = fixture({ quietGates: "failed (q12)" });
    const view = compareView(page, candidateOf(page, "quiet-mornings"), null);
    expect(view.canGoLive).toBe(false);
    expect(view.blocked).toBe("heartbeat: gate failed on case 12");
  });

  test("Make it live is off when nothing is live on the job to replace", () => {
    const { page } = fixture({ drop: [PRODUCTION_HEARTBEAT] });
    const view = compareView(page, candidateOf(page, "quiet-mornings"), null);
    expect(view.canGoLive).toBe(false);
    expect(view.blocked).toBe("Nothing is live on this job to replace");
  });
});

// ---------------------------------------------------------------------------

describe("activity", () => {
  test("each maker maps to its kind: improver and Claude to agents, a person to people, the bench to bench", () => {
    const { catalog, reads } = fixture();
    const rows = activityRows(catalog, reads, NOW);
    expect(rows.find((row) => row.what.startsWith("Drafted quiet-mornings"))).toEqual({
      key: expect.any(String),
      when: "Nov 13",
      who: "Improver",
      kind: "agents",
      job: "Check-in",
      what: "Drafted quiet-mornings: Stay quiet when nothing changed",
    });
    expect(rows.find((row) => row.what.startsWith("Drafted gentler-evenings"))).toMatchObject({ who: "Claude", kind: "agents", when: "—" });
    expect(rows.find((row) => row.what.startsWith("Promoted checkin-v7"))).toEqual({
      key: expect.any(String),
      when: "Nov 6",
      who: "seyi",
      kind: "people",
      job: "Check-in",
      what: "Promoted checkin-v7: live since 2026-11-06",
    });
    expect(rows.find((row) => row.what.startsWith("Ran heartbeat (gh-412)"))).toMatchObject({
      who: "Test bench",
      kind: "bench",
      job: "Check-in",
      when: "09:00",
      what: "Ran heartbeat (gh-412): production 71%, quiet-mornings 95%",
    });
  });

  test("the Tex job's rows are left out of the feed", () => {
    const { catalog, reads } = fixture();
    const rows = activityRows(catalog, reads, NOW);
    expect(rows.some((row) => row.job === "Tex, by text")).toBe(false);
    expect(rows.some((row) => row.what.includes("tex-shorter") || row.what.includes("tex-v3"))).toBe(false);
    expect(rows).toHaveLength(6);
  });

  test("filterActivity keeps the rows of one kind, or all of them", () => {
    const { catalog, reads } = fixture();
    const rows = activityRows(catalog, reads, NOW);
    expect(filterActivity(rows, "all")).toHaveLength(6);
    expect(filterActivity(rows, "agents").map((row) => row.who)).toEqual(["Improver", "Claude"]);
    expect(filterActivity(rows, "people").map((row) => row.who)).toEqual(["seyi"]);
    expect(filterActivity(rows, "bench")).toHaveLength(3);
    expect(filterActivity(rows, "bench").every((row) => row.kind === "bench")).toBe(true);
  });
});
