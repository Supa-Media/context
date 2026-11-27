/**
 * @jest-environment jsdom
 */

/**
 * THE AREA PANEL'S ROUTINES SECTION, AS DEV APPROVED THE ARTBOARDS (2026-11-27: "please build end to end").
 *
 * The section sits after Owner and before Mail; its rows are the area's `routines/<how often>/` notes, and the
 * `routines/` folder is no longer one of the area's Notes. Add writes the note (its schedule, then its name as the
 * heading) and opens it; a row's editor writes `on:`, `at:` and `paused:` as each changes, and moves the note when
 * Repeats changes its folder. An area with none turns on pulse checks, the same notes `manage area { pulse: true }`
 * writes. A phone draws the same panel full width, in place of the list.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({
  useQuery: () => [],
  useAction: () => async () => ({ ok: true, status: 200 }),
  useMutation: () => async () => null,
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => {
    throw new Error("No fixture gateway session");
  },
}));

import type { ListNote } from "../features/console/files/listBlock/model";
import type { FolderListing } from "../features/console/files/types";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { all, entry, host, mount, one, press, strip, unmountAll, windowOf, type Write } from "./projectPage/fixtures";

const AREAS: ListNote[] = [
  { path: "areas/about.md", properties: { agents: ["Grok Bot"] } },
  { path: "areas/bots/grok-bot/about.md", properties: { holder: "Grok Bot", kind: "agent", bot: "grok", belongs_to: "@seyi", works_in: ["areas/finance · 20%"] } },
  { path: "areas/finance/about.md", properties: { owner: "@seyi", delegate: "Grok Bot", modes: ["Manager"] } },
  { path: "areas/finance/routines/daily/manager-loop.md", properties: { at: "10am", on: "weekdays", mode: "Manager" }, heading: "Manager loop" },
  { path: "areas/finance/routines/monthly/month-end-close.md", properties: { at: "4pm", paused: "true" }, heading: "Month-end close" },
  { path: "areas/finance/pricing-notes.md", properties: {} },
  { path: "areas/engineering/about.md", properties: { owner: "@sayo", modes: ["Doer"] } },
];

const LISTING: FolderListing = {
  path: "areas",
  folderDefault: "team",
  entries: [entry("folder", "areas/finance"), entry("folder", "areas/engineering")],
  truncated: false,
  manifestUsable: true,
};

beforeEach(() => {
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage here
  }
});
afterEach(unmountAll);

async function typeInto(input: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** The panel's section titles, in order. */
function sections(): string[] {
  return [...one("area-panel").querySelectorAll("[role=heading], div")]
    .map((node) => strip(node.textContent))
    .filter((text) => ["OWNER", "ROUTINES", "MAIL", "NOTES", "Owner", "Routines", "Mail", "Notes"].includes(text))
    .map((text) => text.toLowerCase());
}

describe("the Routines section", () => {
  test("sits after Owner and before Mail, one row per routine, and the routines folder is not one of the Notes", async () => {
    windowOf(1440);
    await mount(host([], { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    const order = [...new Set(sections())];
    expect(order.indexOf("routines")).toBeGreaterThan(order.indexOf("owner"));
    expect(order.indexOf("routines")).toBeLessThan(order.indexOf("mail"));
    const text = strip(one("area-panel-routines").textContent);
    expect(text).toContain("Manager loop");
    expect(text).toContain("Weekdays at 10 am");
    expect(text).toContain("Monthly on the 1st at 4 pm · paused");
    // No gateway here: no run lines and no placeholders forever.
    expect(text).not.toContain("Hasn't run yet");
    expect(all("area-panel-routines-budget-loading")).toHaveLength(0);
    expect(all("area-panel-note-areas/finance/routines")).toHaveLength(0);
    expect(all("area-panel-note-areas/finance/pricing-notes.md")).toHaveLength(1);
  });

  test("Add writes the note with its schedule and name, then opens it", async () => {
    windowOf(1440);
    const files: string[] = [];
    const { selected } = await mount(host([], { notes: AREAS, files }), LISTING);
    await press(one("area-row-areas/finance"));
    await press(one("area-panel-routine-add"));
    await typeInto(one("area-panel-routine-name"), "Pipeline check");
    await press(one("area-panel-routine-day-5"));
    await press(one("area-panel-routine-day-6"));
    expect(strip(one("area-panel-routine-words").textContent)).toBe("Weekdays at 9 am, New York time.");
    await press(one("area-panel-routine-time-add"));
    await typeInto(one("area-panel-routine-time-new"), "1pm");
    await act(async () => {
      one("area-panel-routine-time-new").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      one("area-panel-routine-time-new").dispatchEvent(new FocusEvent("blur"));
    });
    expect(strip(one("area-panel-routine-words").textContent)).toBe("Weekdays at 9 am and 1 pm, New York time.");
    await press(one("area-panel-routine-create"));
    await settle();
    expect(files).toEqual(["create areas/finance/routines/daily/pipeline-check.md\n---\non: weekdays\nat: [9am, 1pm]\n---\n# Pipeline check\n\n"]);
    expect(selected).toEqual(["areas/finance/routines/daily/pipeline-check.md"]);
  });

  test("a row's editor writes each change as it is made, and moves the note when Repeats changes", async () => {
    windowOf(1440);
    const writes: Write[] = [];
    const files: string[] = [];
    const { selected } = await mount(host(writes, { notes: AREAS, files }), LISTING);
    await press(one("area-row-areas/finance"));
    await press(one("area-panel-routine-areas/finance/routines/daily/manager-loop.md"));
    expect(all("area-panel-routine-edit-areas/finance/routines/daily/manager-loop.md")).toHaveLength(1);
    const path = "areas/finance/routines/daily/manager-loop.md";
    const of = (key: string) => writes.filter(([at, k]) => at === path && k === key).map(([, , value]) => value);
    await press(one("area-panel-routine-day-2"));
    expect(of("on").at(-1)).toBe("mon, tue, thu, fri");
    await press(one("area-panel-routine-runs"));
    expect(of("paused").at(-1)).toBe("true");
    await press(one("area-panel-routine-repeats-Weekly"));
    await settle();
    expect(files).toContain(`move ${path} -> areas/finance/routines/weekly/manager-loop.md`);
    // Still editing it where it went.
    expect(all("area-panel-routine-open")).toHaveLength(1);
    await press(one("area-panel-routine-open"));
    expect(selected).toEqual(["areas/finance/routines/weekly/manager-loop.md"]);
  });

  test("an area with none turns on pulse checks: the templates its modes ask for", async () => {
    windowOf(1440);
    const files: string[] = [];
    const notes = AREAS.filter((note) => !note.path.includes("/routines/"));
    await mount(host([], { notes, files }), LISTING);
    await press(one("area-row-areas/finance"));
    const text = strip(one("area-panel-routines").textContent);
    expect(text).toContain("No routines yet. Context sends each one to Grok Bot on time");
    expect(text).toContain("Adds Improve your metric and Manager loop, from Finance's modes.");
    await press(one("area-panel-pulse"));
    await settle();
    expect(files.map((file) => file.split("\n")[0])).toEqual([
      "create areas/finance/routines/daily/improve-your-metric.md",
      "create areas/finance/routines/daily/manager-loop.md",
    ]);
  });

  test("a reader sees the routines and changes none", async () => {
    windowOf(1440);
    await mount(host(null, { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    expect(all("area-panel-routine-add")).toHaveLength(0);
    await press(one("area-panel-routine-areas/finance/routines/daily/manager-loop.md"));
    expect(all("area-panel-routine-edit-areas/finance/routines/daily/manager-loop.md")).toHaveLength(0);
  });
});

describe("on a phone", () => {
  test("a press draws the area's panel full width in place of the list, and its X goes back", async () => {
    windowOf(390);
    const { selected } = await mount(host([], { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    expect(selected).toEqual([]);
    expect(all("areas-phone-panel")).toHaveLength(1);
    expect(strip(one("areas-phone-panel").textContent)).toContain("Manager loop");
    expect(all("task-panel-peek")).toHaveLength(0);
    await press(one("area-panel-open"));
    expect(selected).toEqual(["areas/finance"]);
    await press(one("area-row-areas/engineering"));
    await press(one("area-panel-close"));
    expect(all("areas-phone-panel")).toHaveLength(0);
  });
});
