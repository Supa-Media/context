/**
 * @jest-environment jsdom
 */

/**
 * tex.lc/admin, actually rendered: the Tex dashboard is a page of its own, not
 * a tab in the staff console (the owner, 2026-10-24), redesigned around where
 * Tex hurts and whether it is getting better.
 *
 *  1. **The host decides.** `/admin` on tex.lc draws the dashboard; on
 *     context.lc it is still the console's redirect to Growth.
 *  2. **Do next names the worst unfixed problem**, and its button sends that
 *     problem's note to the triage agent.
 *  3. **Every number has a target and the window before**, and says when it
 *     rests on too few chats to call.
 *  4. **Where it hurts** lists the problems, unfixed first, with a shipped
 *     fix's before and since.
 *  5. **The window reaches the query**, asked for twice over.
 *  6. **The bug desk** counts reports, opens one, and comments or retires it.
 *  7. **Explore's filters still narrow the table.**
 *  8. **Somebody who is not staff sees "Staff only"**, and nothing is asked
 *     for.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-10-24):
 *
 *   `AdminRoute` ignoring the host (always redirecting)             6
 *   `applyFilters` ignoring the filters                             2
 *   `texReport` asked without the staff check ("skip" removed)      1
 *   `painRowsOf` sorting shipped problems first                     2
 *   `NoteReader` sending "triage" for Retire                        1
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockArgs = new Map<string, unknown>();
let mockTexHost = true;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      mockArgs.set(name, args);
      return args === "skip" ? undefined : mockAnswers.get(name);
    },
    useAction: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        mockArgs.set(name, args);
        const answer = mockAnswers.get(name);
        if (answer instanceof Error) throw answer;
        return answer;
      };
    },
  };
});

jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});

jest.mock("../features/site/host", () => ({ isTexHost: () => mockTexHost }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import AdminRoute from "../app/(app)/admin/index";

const roots: (() => void)[] = [];

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockArgs.clear();
  mockTexHost = true;
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(AdminRoute));
  });
  return container;
}

function find(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function click(testID: string): void {
  const node = find(testID);
  if (node === null) throw new Error(`no control called ${testID}`);
  act(() => {
    node.click();
  });
}

const TEX = "functions/admin:texReport";
const SPEND = "functions/texSpend:report";

function spend() {
  return {
    configured: true,
    error: null,
    totalUsd: 21.5,
    testsUsd: 8,
    keptFrom: "2026-08-26",
    days: [
      { day: "2026-10-23", usd: 6.5, requests: 300 },
      { day: "2026-10-24", usd: 15, requests: 500 },
    ],
    models: [{ model: "claude-opus-5-5", requests: 400, usd: 18, freshInputTokens: 1_000, cacheReadTokens: 9_000, cacheWriteTokens: 0, outputTokens: 2_000 }],
    jobs: [
      { job: "texts", usd: 19, requests: 600 },
      { job: "heartbeat", usd: 2.5, requests: 200 },
    ],
  };
}
const ADMIN = "functions/admin:amIAdmin";

/** After codes began (Oct 24, 18:00 UTC), so every row counts. */
const SCORED = Date.parse("2026-10-24T20:00:00Z");
const NOW = Date.parse("2026-10-25T06:00:00Z");

function review(over: Record<string, unknown> = {}) {
  return {
    at: SCORED,
    kind: "one",
    reason: "ended",
    goal: 8,
    independence: 8,
    turns: 8,
    friendly: 8,
    calm: 9,
    task: "email",
    signals: [],
    texts: 2,
    who: "other",
    costMicroUsd: 1_000,
    thought: false,
    ...over,
  };
}

function report() {
  return {
    days: 7,
    turnDays: 2,
    turns: {
      truncated: false,
      total: 14,
      byKind: { one: 9, group: 3, job: 1, routine: 1, app: 0, older: 0 },
      answered: 12,
      exhausted: 1,
      failed: 1,
      costMicroUsd: 3_200_000,
      priced: 14,
      byDay: [
        { day: "2026-10-23", turns: 6, texts: 5, troubled: 1, costMicroUsd: 1_000_000 },
        { day: "2026-10-24", turns: 8, texts: 7, troubled: 2, costMicroUsd: 2_200_000 },
      ],
      models: [{ model: "fake-provider/think-model", turns: 4, inputTokens: 12_000, outputTokens: 2_000, cacheReadTokens: 0, costMicroUsd: 3_000_000 }],
      tools: [{ tool: "browse", calls: 10, failed: 3 }],
    },
    performance: {
      time: { totalMs: 140_000, modelMs: 90_000, toolMs: 30_000, p50: 4_200, p95: 75_000 },
      wait: { turns: 6, p50: 12_000, p95: 238_000, max: 241_000 },
      models: [{ model: "fake-provider/think-model", rounds: 20, failed: 2, retried: 1, cut: 0, fallbacks: 1, p50: 3_000, p95: 9_000 }],
      router: { picks: 10, think: 3, confidence: 0.8 },
      daily: [
        { p50: 4_000, p95: 70_000 },
        { p50: 4_400, p95: 80_000 },
      ],
      tools: [{ tool: "browse", p50: 6_000 }],
    },
    reviewsTruncated: false,
    reviews: [
      review({ at: SCORED - 3_600_000 }),
      review({ task: "web_errand", signals: ["try_again"], calm: 3, texts: 6, goal: 5 }),
      review({ task: "web_errand", calm: 4, kind: "group" }),
      review({ task: "web_errand", calm: 2, goal: 4 }),
      review({ task: "calendar" }),
    ],
  };
}

const TRIAGE = "functions/texDashboard:triage";
const READ = "functions/texDashboard:readNote";
const ACT = "functions/texDashboard:act";
const OPEN_THEME = "areas/tex-reviews/themes/retries-on-errands.md";
const BUG = "areas/tex-bugs/user/2026-10-24 2100 reminder never came abc123.md";

function triage() {
  const theme = { signals: [] as string[], tasks: [] as string[], prs: [] as number[], merged: null, firstSeen: null, fixThread: null, retest: null };
  return {
    available: true,
    slug: "context-lc",
    bugs: [
      { path: BUG, filed: Date.parse("2026-10-24T21:00:00Z"), status: "open", reporter: "user", textsShared: true, title: "Reminder never came", theme: null, themes: [] },
      { path: "areas/tex-bugs/team/2026-10-24 1000 old one def456.md", filed: Date.parse("2026-10-24T10:00:00Z"), status: "retired", reporter: "team", textsShared: false, title: "Old one", theme: null, themes: [] },
    ],
    reviews: [{ path: "areas/tex-reviews/2026-10-24 2000 calm 2 aaaaaa.md", reviewed: SCORED, status: "new", theme: "retries-on-errands", themes: ["retries-on-errands"], task: "web_errand", signals: ["try_again"], average: 4 }],
    themes: [
      { ...theme, path: "areas/tex-reviews/themes/note-saves.md", slug: "note-saves", name: "Note saves time out", status: "shipped", signals: ["repeated"], tasks: ["notes"], prs: [2154], merged: Date.parse("2026-10-24T00:00:00Z") },
      { ...theme, path: OPEN_THEME, slug: "retries-on-errands", name: "Errands need a retry", status: "open", signals: ["try_again"], tasks: ["web_errand"] },
    ],
  };
}

function asStaff(withSpend: unknown = spend(), desk: unknown = triage()): HTMLElement {
  mockAnswers.set(ADMIN, true);
  mockAnswers.set(TEX, report());
  mockAnswers.set(SPEND, withSpend);
  mockAnswers.set(TRIAGE, desk);
  const container = mount();
  // The billed spend arrives from an action, after the first paint.
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function pick(testID: string, value: string): void {
  const select = find(testID) as HTMLSelectElement | null;
  if (select === null) throw new Error(`no select called ${testID}`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("tex.lc/admin", () => {
  test("is the dashboard on tex.lc, and still the console's redirect on context.lc", () => {
    asStaff();
    expect(find("tex-dashboard")).not.toBeNull();
    expect(find("redirect")).toBeNull();
    roots.pop()!();
    mockTexHost = false;
    mount();
    expect(find("tex-dashboard")).toBeNull();
    expect(find("redirect")?.getAttribute("data-href")).toBe("/admin/growth");
  });

  test("do next names the worst problem nobody is fixing, and sends it to triage", async () => {
    asStaff();
    await settle();
    const today = find("tex-dashboard-today")?.textContent ?? "";
    expect(today).toContain("Errands need a retry: 1 chat in 14 days, and nobody is fixing it yet.");
    // The shipped fix: one notes chat could have hit it since, too few to judge.
    expect(today).toContain("#2154 Note saves time out: 0 of 0 before, 0 of 0 since. Too early, 5 more to judge.");
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "Send to triage to fix");
    act(() => button!.click());
    await settle();
    expect(mockArgs.get(ACT)).toEqual({ path: OPEN_THEME, action: "triage" });
  });

  test("every number has its target and the window before, and says when there are too few to call", async () => {
    asStaff();
    await settle();
    const success = find("tex-dashboard-tile-success")?.textContent ?? "";
    // Five scored chats; the two emails, the calendar one and one errand got what they wanted.
    expect(success).toContain("60%");
    expect(success).toContain("Target 70%");
    expect(success).toContain("5 scored chats in 7 days");
    // Codes began this week, so there is no window before to compare with.
    expect(success).toContain("no window before");
    expect(find("tex-dashboard-tile-p95")?.textContent).toContain("75s");
    expect(find("tex-dashboard-tile-p95")?.textContent).toContain("Target under 60s");
    expect(find("tex-dashboard-tile-troubled")?.textContent).toContain("21%");
  });

  test("where it hurts puts the unfixed problem first, and a shipped one says when", async () => {
    asStaff();
    await settle();
    const rows = [...document.querySelectorAll('[data-testid^="tex-dashboard-pain-"]')].map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["tex-dashboard-pain-retries-on-errands", "tex-dashboard-pain-note-saves"]);
    expect(find("tex-dashboard-pain-retries-on-errands")?.textContent).toContain("No fix yet");
    expect(find("tex-dashboard-pain-note-saves")?.textContent).toContain("Shipped Oct 24");
    // Merged is not fixed: the row says nobody has rerun the original ask yet.
    expect(find("tex-dashboard-pain-note-saves")?.textContent).toContain("Not retested yet");
    expect(find("tex-dashboard-pain-note-saves")?.textContent).toContain("#2154");
  });

  test("the window reaches the report, asked for twice over, and the billed spend", async () => {
    asStaff();
    await settle();
    expect(mockArgs.get(TEX)).toEqual({ days: 30 });
    expect(mockArgs.get(SPEND)).toEqual({ days: 7 });
    pick("tex-dashboard-window", "30");
    await settle();
    expect(mockArgs.get(TEX)).toEqual({ days: 90 });
    expect(mockArgs.get(SPEND)).toEqual({ days: 30 });
  });

  test("the bug desk counts reports, opens one, and comments on it or retires it", async () => {
    asStaff();
    await settle();
    expect(find("tex-dashboard-bugs")?.textContent).toContain("1 waiting");
    // Waiting reports by default; the retired one is behind the dropdown.
    expect(document.querySelectorAll('[data-testid="tex-dashboard-bug"]')).toHaveLength(1);
    pick("tex-dashboard-bugs-show", "all");
    expect(document.querySelectorAll('[data-testid="tex-dashboard-bug"]')).toHaveLength(2);
    mockAnswers.set(READ, { path: BUG, text: "---\nstatus: open\n---\n\n# Reminder never came\n", mail: [{ at: "2026-10-24T22:00:00.000Z", from: "triage", to: "everyone", text: "Looking at it" }] });
    mockAnswers.set(ACT, { status: "retired" });
    act(() => (document.querySelector('[data-testid="tex-dashboard-bug"]') as HTMLButtonElement).click());
    await settle();
    expect(mockArgs.get(READ)).toEqual({ path: BUG });
    const reader = find("tex-dashboard-reader")?.textContent ?? "";
    expect(reader).toContain("# Reminder never came");
    expect(reader).toContain("Looking at it");
    const box = document.getElementById("td-comment") as HTMLTextAreaElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(box, "Duplicate of the reminders fix");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const retire = [...document.querySelectorAll("button")].find((node) => node.textContent === "Retire");
    act(() => retire!.click());
    await settle();
    expect(mockArgs.get(ACT)).toEqual({ path: BUG, action: "retire", comment: "Duplicate of the reminders fix" });
  });

  test("staff who are not on the team context are told why problems and bugs are missing", async () => {
    asStaff(spend(), { available: false, reason: "not_a_member" });
    await settle();
    expect(document.body.textContent).toContain("not a member of the team context");
    expect(find("tex-dashboard-bugs")).toBeNull();
  });

  test("without Cloudflare connected, the cost says it is our estimate", async () => {
    asStaff({ configured: false });
    await settle();
    expect(find("tex-dashboard-cost")?.textContent).toContain("our estimate");
    expect(find("tex-dashboard-spend-compare")?.textContent).toContain("isn't connected");
  });

  test("a task picked from Explore's dropdown narrows the table, and Clear brings it back", () => {
    asStaff();
    expect(find("tex-dashboard-table")?.textContent).toContain("Email");
    click("tex-dashboard-filter-task");
    click("tex-dashboard-filter-task-web_errand");
    expect(find("tex-dashboard-table")?.textContent).not.toContain("Email");
    expect(find("tex-dashboard-explore-count")?.textContent).toContain("3 of 5 conversations");
    click("tex-dashboard-clear");
    expect(find("tex-dashboard-table")?.textContent).toContain("Email");
  });

  test("somebody who is not staff sees Staff only, and nothing is asked for", () => {
    mockAnswers.set(ADMIN, false);
    mockAnswers.set(TEX, report());
    mount();
    expect(find("tex-dashboard-staff-only")?.textContent).toContain("Staff only");
    expect(mockArgs.get(TEX)).toBe("skip");
    expect(mockArgs.get(TRIAGE)).toBe("skip");
  });
});
