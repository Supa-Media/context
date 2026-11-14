/** @jest-environment jsdom */
/**
 * The Jobs page's acts (`jobsPage.acts` in `features/admin/console/pages/Jobs.web.tsx`), run against
 * the HTML `jobsPage.props` draws: opening a case calls no model, Try it asks live once and only with
 * a workspace of one's own, what is typed in the case panel survives a redraw, rules are added and
 * removed without losing what was typed, Save, Delete and Undo reach the writes, Make it live needs
 * the right candidate, and Run both opens the bench. Fixtures are fake.
 */
import { beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";
import { jobPage } from "../features/admin/aiModel";
import { jobsPage } from "../features/admin/console/pages/Jobs.web";
import { drafts, tries } from "../features/admin/console/pages/jobs/jobsView";
import type { JobsPageData } from "../features/admin/console/pages/jobs/useJobsPage";
import { S, setRoutes, toastState } from "../features/admin/console/state";

jest.mock("convex/react", () => ({ useQuery: jest.fn(), useAction: jest.fn(), useConvex: jest.fn(), useMutation: jest.fn() }));
jest.mock("@convex-dev/auth/react", () => ({ useAuthToken: jest.fn() }));

const NOW = new Date(2026, 10, 14, 12, 0).getTime();
const note = (path: string, properties: Record<string, unknown> = {}, updatedAt = NOW - 3_600_000): FolderNote =>
  ({ path, props: JSON.stringify({ properties, heading: "", lede: "" }), updatedAt, size: 400 }) as FolderNote;

const LIST = [
  "---",
  "job: heartbeat",
  "---",
  "",
  "# Staying quiet",
  "",
  "## 1. Quiet morning",
  "",
  "Morning look, no new mail",
  "",
  "- must not: text them",
  "- may: write a note",
  "",
  "## 2. Evening check",
  "",
  "- must: ask first",
  "",
].join("\n");

const catalog = buildCatalog([
  note("ai/production/heartbeat.md", { from: "checkin-v7", live_since: "2026-11-06", promoted_by: "seyi" }),
  note("ai/tests/heartbeat.md", { job: "heartbeat" }),
  note("ai/setups/heartbeat/checkin-v7.md", { job: "heartbeat", made_by: "seyi" }),
  note("ai/setups/heartbeat/quiet-mornings.md", { job: "heartbeat", change: "Mornings stay quiet", made_by: "improver" }, NOW - 7_200_000),
]);

const TEST_PATH = "ai/tests/heartbeat.md";

function data(over: Partial<JobsPageData> = {}): JobsPageData {
  const page = jobPage(catalog, "heartbeat", new Map());
  return {
    state: { kind: "ready" } as JobsPageData["state"],
    catalog,
    reads: new Map(),
    workspaceId: "w" as JobsPageData["workspaceId"],
    me: "@tester",
    reload: jest.fn(),
    reloads: 0,
    now: NOW,
    page,
    texts: new Map([[TEST_PATH, LIST]]),
    candidate: null,
    liveText: null,
    candidateText: null,
    replies: null,
    writes: {
      saveCase: jest.fn(async () => undefined),
      newCase: jest.fn(async () => 3),
      copyCase: jest.fn(async () => 3),
      deleteCase: jest.fn(async () => ["## 1. Quiet morning", "", "- must not: text them"]),
      restoreCase: jest.fn(async () => undefined),
      newExperiment: jest.fn(async () => "experiment-3"),
      makeLive: jest.fn(async () => undefined),
      runBoth: jest.fn(async () => true),
    } as unknown as JobsPageData["writes"],
    rereadTests: jest.fn(),
    mint: jest.fn(async () => ({ accessToken: "t" })) as unknown as JobsPageData["mint"],
    ownWorkspace: "w1" as JobsPageData["ownWorkspace"],
    ...over,
  };
}

/** The HTML of a case's panel, drawn into the console's own `.sc` root so the acts see the same DOM. */
function drawPanel(d: JobsPageData, id = "heartbeat-1") {
  const html = jobsPage.props!(d, id);
  if (html === null) throw new Error("no panel");
  document.body.innerHTML = `<div class="sc">${html}</div>`;
  return document.querySelector<HTMLElement>(".sc")!;
}

/** The element an act's button is, as the page's own click would find it. */
const actEl = (act: string, id?: string, extra: Record<string, string> = {}) => {
  const el = document.createElement("button");
  el.dataset.act = act;
  if (id !== undefined) el.dataset.id = id;
  for (const [k, v] of Object.entries(extra)) el.dataset[k] = v;
  return el;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeAll(() => {
  setRoutes({
    pages: ["home", "jobs"],
    windowed: new Set(),
    filters: { who: ["all", ["jobs"]] },
  });
});

beforeEach(() => {
  document.body.innerHTML = "";
  drafts.clear();
  tries.clear();
  global.fetch = jest.fn() as unknown as typeof fetch;
  Object.assign(S, { p: "jobs", subs: ["heartbeat"], x: null, f: { who: "all" }, confirm: null, sel: new Set() });
});

describe("opening a case", () => {
  test("props() makes no fetch call", () => {
    const d = data();
    jobsPage.props!(d, "heartbeat-1");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("Try it on live", () => {
  test("asks live once, through the gateway", async () => {
    const d = data({
      mint: jest.fn(async () => ({ accessToken: "t" })) as unknown as JobsPageData["mint"],
    });
    (global.fetch as unknown as jest.Mock).mockResolvedValue({
      status: 200,
      json: async () => ({ answer: "Good morning.", checks: [] }),
    } as never);
    drawPanel(d);
    jobsPage.acts!.tryit(actEl("tryit", "heartbeat-1"), d);
    await flush();
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mcp.context.lc/agent/try");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(tries.get("heartbeat-1")).toMatchObject({ running: false, answer: "Good morning.", passed: true });
  });

  test("with no workspace of one's own it is skipped with a toast, and fetch is not called", () => {
    const d = data({ ownWorkspace: null });
    drawPanel(d);
    jobsPage.acts!.tryit(actEl("tryit", "heartbeat-1"), d);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(toastState.text).toContain("needs your own workspace");
    expect(toastState.shown).toBe(true);
  });
});

describe("the case panel's typing", () => {
  test("typed text in the textarea survives a later props() call", () => {
    const d = data();
    const root = drawPanel(d);
    root.querySelector<HTMLTextAreaElement>("#cw")!.value = "Typed but not saved yet";
    const again = jobsPage.props!(d, "heartbeat-1")!;
    expect(again).toContain("Typed but not saved yet");
  });

  test("addrule adds an empty rule row, and a rule typed before it is kept", () => {
    const d = data();
    const root = drawPanel(d);
    expect(root.querySelectorAll("[data-rule-text]")).toHaveLength(2);
    root.querySelector<HTMLInputElement>('[data-rule-text="0"]')!.value = "text nobody at night";
    jobsPage.acts!.addrule(actEl("addrule", "heartbeat-1"), d);
    expect(drafts.get("heartbeat-1")!.rules).toEqual([
      { kind: "must not", text: "text nobody at night" },
      { kind: "may", text: "write a note" },
      { kind: "must", text: "" },
    ]);
    // The host redraws the panel from the draft: the typed rule and the new empty row are both there.
    const redrawn = jobsPage.props!(d, "heartbeat-1")!;
    expect(redrawn.match(/data-rule-text="\d"/g)).toHaveLength(3);
    expect(redrawn).toContain("text nobody at night");
  });

  test("rmrule removes the row it names and keeps the others as typed", () => {
    const d = data();
    const root = drawPanel(d);
    root.querySelector<HTMLInputElement>('[data-rule-text="1"]')!.value = "write a note, briefly";
    jobsPage.acts!.rmrule(actEl("rmrule", "heartbeat-1", { i: "0" }), d);
    expect(drafts.get("heartbeat-1")!.rules).toEqual([{ kind: "may", text: "write a note, briefly" }]);
  });
});

describe("saving, deleting and undoing a case", () => {
  test("saved calls writes.saveCase with the typed draft", async () => {
    const d = data();
    const root = drawPanel(d);
    root.querySelector<HTMLTextAreaElement>("#cw")!.value = "Morning look, nothing new";
    root.querySelector<HTMLInputElement>('[data-rule-text="0"]')!.value = "text them at all";
    await jobsPage.acts!.saved(actEl("saved", "heartbeat-1"), d);
    expect(d.writes.saveCase).toHaveBeenCalledWith(TEST_PATH, 1, {
      name: "Quiet morning",
      when: "Morning look, nothing new",
      rules: [
        { kind: "must not", text: "text them at all" },
        { kind: "may", text: "write a note" },
      ],
    });
    expect(d.rereadTests).toHaveBeenCalled();
  });

  test("delcase calls deleteCase; the toast's undo calls restoreCase with the returned block", async () => {
    const block = ["## 1. Quiet morning", "", "- must not: text them"];
    const d = data({
      writes: { ...data().writes, deleteCase: jest.fn(async () => block), restoreCase: jest.fn(async () => undefined) } as unknown as JobsPageData["writes"],
    });
    drawPanel(d);
    await jobsPage.acts!.delcase(actEl("delcase", "heartbeat-1"), d);
    expect(d.writes.deleteCase).toHaveBeenCalledWith(TEST_PATH, 1);
    expect(toastState.text).toBe("Case deleted");
    expect(typeof toastState.undo).toBe("function");

    toastState.undo!();
    await flush();
    expect(d.writes.restoreCase).toHaveBeenCalledWith(TEST_PATH, block);
    expect(d.rereadTests).toHaveBeenCalled();
  });
});

describe("Make it live", () => {
  const candidate = () => jobPage(catalog, "heartbeat", new Map())!.candidates.find((item) => item.name === "quiet-mornings")!;

  test("with a mismatched data-id it does nothing", async () => {
    const d = data({ candidate: candidate() });
    await jobsPage.acts!.makelive(actEl("makelive", "checkin-v7"), d);
    expect(d.writes.makeLive).not.toHaveBeenCalled();
  });

  test("with the right id it calls writes.makeLive", async () => {
    const d = data({ candidate: candidate() });
    await jobsPage.acts!.makelive(actEl("makelive", "quiet-mornings"), d);
    expect(d.writes.makeLive).toHaveBeenCalledWith(d.page, d.candidate);
    expect(toastState.text).toBe("quiet-mornings is live");
  });
});

describe("Run both", () => {
  test("goes to the runs tab when open returns true", async () => {
    const d = data();
    await jobsPage.acts!.runboth(actEl("runboth", "quiet-mornings"), d);
    expect(d.writes.runBoth).toHaveBeenCalled();
    expect(S.subs).toEqual(["heartbeat", "runs"]);
  });

  test("stays put when open returns false", async () => {
    const d = data({
      writes: { ...data().writes, runBoth: jest.fn(async () => false) } as unknown as JobsPageData["writes"],
    });
    await jobsPage.acts!.runboth(actEl("runboth", "quiet-mornings"), d);
    expect(S.subs).toEqual(["heartbeat"]);
    expect(toastState.text).toBe("The test bench didn't open");
  });
});
