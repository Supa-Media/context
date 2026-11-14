/**
 * The staff console's Jobs page HTML (`features/admin/console/pages/jobs/jobsView.ts`): Tex's row
 * opens the Lab, Activity filters by who, a job's tabs draw its cases, setups and runs, the case
 * panel edits a case, and nothing a note says reaches the page unescaped. Fixtures are fake.
 */
import { describe, expect, test } from "@jest/globals";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";
import { jobPage } from "../features/admin/aiModel";
import { S } from "../features/admin/console/state";
import { caseProps, jobCrumb, jobView, listView, notReady } from "../features/admin/console/pages/jobs/jobsView";
import type { JobsPageData } from "../features/admin/console/pages/jobs/useJobsPage";

const NOW = new Date(2026, 10, 14, 12, 0).getTime();
const note = (path: string, properties: Record<string, unknown> = {}, updatedAt = NOW - 3_600_000): FolderNote =>
  ({ path, props: JSON.stringify({ properties, heading: "", lede: "" }), updatedAt, size: 400 }) as FolderNote;

const EVIL = `<img src=x onerror="alert(1)">`;
const LIST = ["---", "job: heartbeat", "---", "", `# Staying quiet ${EVIL}`, "", `## 1. Quiet ${EVIL}`, "", "Morning look, no new mail", "", "- must not: text them", "- may: write a note", ""].join("\n");

const catalog = buildCatalog([
  note("ai/production/heartbeat.md", { from: "checkin-v7", live_since: "2026-11-06", promoted_by: "seyi" }),
  note("ai/tests/heartbeat.md", { job: "heartbeat" }),
  note("ai/setups/heartbeat/checkin-v7.md", { job: "heartbeat", made_by: "seyi" }),
  note(`ai/setups/heartbeat/quiet-mornings.md`, { job: "heartbeat", change: `Mornings stay quiet ${EVIL}`, made_by: "improver" }, NOW - 7_200_000),
]);

function data(over: Partial<JobsPageData> = {}): JobsPageData {
  const page = jobPage(catalog, "heartbeat", new Map());
  return {
    state: { kind: "ready" } as JobsPageData["state"],
    catalog,
    reads: new Map(),
    workspaceId: "w" as JobsPageData["workspaceId"],
    me: "@tester",
    reload: () => {},
    reloads: 0,
    now: NOW,
    page,
    texts: new Map([["ai/tests/heartbeat.md", LIST]]),
    candidate: null,
    liveText: null,
    candidateText: null,
    replies: null,
    writes: {} as JobsPageData["writes"],
    rereadTests: () => {},
    mint: (() => Promise.reject(new Error("no"))) as unknown as JobsPageData["mint"],
    ownWorkspace: null,
    ...over,
  };
}

const at = (subs: string[], x: string | null = null, f: Record<string, string> = { who: "all" }) => Object.assign(S, { p: "jobs", subs, x, f, confirm: null });

describe("the Jobs list", () => {
  test("Tex's row links to the Lab and opens nothing here; other jobs open their page", () => {
    at([]);
    const html = listView(data());
    expect(html).toContain('href="https://context.lc/lab"');
    expect(html).not.toContain('data-subs="texting-assistant"');
    expect(html).toContain('data-subs="heartbeat"');
    expect(html).toContain("checkin-v7");
  });

  test("Activity filters by who, and says so when nobody matches", () => {
    at(["activity"], null, { who: "bench" });
    const html = listView(data());
    expect(html).toContain("Nothing from them yet");
    at(["activity"], null, { who: "agents" });
    expect(listView(data())).toContain("<td>improver</td>");
  });

  test("a page with no access says why instead of drawing", () => {
    expect(notReady(data({ state: { kind: "notEditor" } as JobsPageData["state"] }))).toContain("can edit @context-lc");
    expect(notReady(undefined)).toContain("Reading");
  });
});

describe("a job", () => {
  test("cases are grouped by their list, escaped", () => {
    at(["heartbeat"]);
    const html = jobView(data());
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('data-act="newcase"');
    expect(jobCrumb(data())).toContain("Check-in");
    // While the notes load, the crumb already names the job, never its key.
    expect(jobCrumb(undefined)).toContain(">Check-in</button>");
    expect(jobCrumb(undefined)).not.toContain(">heartbeat<");
  });

  test("setups show the change escaped and offer Compare to everything but live", () => {
    at(["heartbeat", "setups"]);
    const html = jobView(data());
    expect(html).not.toContain("<img");
    expect(html).toContain('data-subs="heartbeat,compare,quiet-mornings"');
    expect(html).not.toContain('data-subs="heartbeat,compare,checkin-v7"');
    expect(html).toContain('data-act="newsetup"');
  });

  test("the case panel holds its rules as editable rows", () => {
    at(["heartbeat"], "heartbeat-1");
    const html = caseProps(data(), "heartbeat-1")!;
    expect(html).not.toContain("<img");
    expect(html).toContain('data-rule-text="0"');
    expect(html).toContain('value="text them"');
    expect(html).toContain('data-act="saved"');
    expect(caseProps(data(), "heartbeat-99")).toBeNull();
  });

  test("a job that does not exist says so", () => {
    at(["nope"]);
    expect(jobView(data({ page: null }))).toContain("No job called nope");
  });
});
