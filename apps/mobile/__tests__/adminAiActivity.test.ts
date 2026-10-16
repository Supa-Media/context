/**
 * @jest-environment jsdom
 */

/**
 * The AI tab's Activity (`features/admin/AiActivity.tsx`, board 11). The pure
 * `lastNight` sentence is pinned word for word; the rendered feed shows that
 * "Needs a person" hides every row without a person waiting on it.
 */

import { beforeEach, afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("expo-router", () => ({ useRouter: () => ({ push: () => {} }) }));
const mockCloudflare = async () => ({ configured: false, workersAi: [], gateway: [], billedUsd: 0 });
jest.mock("convex/react", () => ({
  useQuery: () => undefined,
  useAction: () => mockCloudflare,
}));
jest.mock("@context/convex/_generated/api", () => {
  const named = (name: string) => ({ _name: name });
  return {
    api: {
      functions: {
        files: { readNote: named("files.readNote"), writeNote: named("files.writeNote") },
        admin: { aiCostsReport: named("admin.aiCostsReport"), aiCostsCloudflare: named("admin.aiCostsCloudflare"), aiCostsAccount: named("admin.aiCostsAccount") },
      },
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AiActivity, lastNight } from "../features/admin/AiActivity";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";
import type { ActivityItem } from "../features/admin/aiModel";
import type { AiScreenProps } from "../features/admin/aiScreen";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function item(overrides: Partial<ActivityItem> & Pick<ActivityItem, "who" | "kind" | "what">): ActivityItem {
  return { at: NOW - HOUR, job: "Tex, by text", path: "ai/setups/texting-assistant/live-6.md", needsPerson: false, ...overrides };
}

describe("lastNight", () => {
  test("says what ran in the last day, counts the setups and the bench's runs, and what waits on a person", () => {
    const items: ActivityItem[] = [
      item({ who: "Improver", kind: "improver", what: "Drafted live-6 from live-5: never merge two to-dos", needsPerson: true }),
      item({ who: "Improver", kind: "improver", what: "Drafted live-7 from live-5: shorter", needsPerson: false, at: NOW - 2 * HOUR }),
      item({ who: "Test bench", kind: "bench", what: "Ran core (gh-33)", path: "ai/results/2026-10-16 core gh-33 scores.md", at: NOW - 3 * HOUR }),
      // Older than a day: not counted, though it is a person's to do.
      item({ who: "Improver", kind: "improver", what: "Drafted live-4 from live-3", needsPerson: true, at: NOW - 2 * 24 * HOUR }),
    ];
    expect(lastNight(items, NOW)).toBe(
      "Last day: the improver drafted 2 setups, the test bench ran once, and left 1 thing for a person. Nothing went live without a person.",
    );
  });

  test("leaves out the waiting clause when nothing waits, and says runs in the plural", () => {
    const items: ActivityItem[] = [
      item({ who: "Improver", kind: "improver", what: "Drafted live-7 from live-5: shorter" }),
      item({ who: "Test bench", kind: "bench", what: "Ran core (gh-33)", at: NOW - HOUR }),
      item({ who: "Test bench", kind: "bench", what: "Ran core (gh-34)", at: NOW - 2 * HOUR }),
      item({ who: "Test bench", kind: "bench", what: "Ran core (gh-35)", at: NOW - 3 * HOUR }),
    ];
    expect(lastNight(items, NOW)).toBe("Last day: the improver drafted 1 setup and the test bench ran 3 times. Nothing went live without a person.");
  });

  test("names a person who retired a setup", () => {
    const items: ActivityItem[] = [item({ who: "Seyi", kind: "person", what: "Retired caveman-2026-10-14: lost to live 3 runs in a row" })];
    expect(lastNight(items, NOW)).toBe("Last day: Seyi retired 1 setup. Nothing went live without a person.");
  });

  test("says nothing ran when every item is older than a day", () => {
    const items: ActivityItem[] = [item({ who: "Improver", kind: "improver", what: "Drafted live-4 from live-3", needsPerson: true, at: NOW - 2 * 24 * HOUR })];
    expect(lastNight(items, NOW)).toBe("Nothing ran on its own in the last day.");
    expect(lastNight([], NOW)).toBe("Nothing ran on its own in the last day.");
  });
});

// ---------------------------------------------------------------------------
// The rendered feed

const T = Date.now();
const notes: FolderNote[] = [
  {
    path: "ai/production/texting-assistant.md",
    updatedAt: T - 5 * 86_400_000,
    props: JSON.stringify({ properties: { from: "live-5", live_since: "2026-10-14", promoted_by: "Seyi" }, heading: "Tex", lede: "" }),
  },
  {
    path: "ai/setups/texting-assistant/live-7.md",
    updatedAt: T - HOUR,
    props: JSON.stringify({ properties: { job: "texting-assistant", status: "draft", made_by: "Claude (Seyi's)", based_on: "live-5", change: "Never add a to-do" }, heading: "live-7", lede: "" }),
  },
  {
    path: "ai/setups/texting-assistant/live-8.md",
    updatedAt: T - 2 * HOUR,
    props: JSON.stringify({ properties: { job: "texting-assistant", made_by: "Seyi", based_on: "live-5", change: "Shorter" }, heading: "live-8", lede: "" }),
  },
];

let container: HTMLDivElement;
let root: Root;
const go = jest.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  go.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = () => container.querySelectorAll<HTMLElement>('[data-testid^="admin-ai-activity-row-"]');

async function render() {
  const props: AiScreenProps = {
    workspaceId: "ws" as never,
    catalog: buildCatalog(notes),
    reads: new Map(),
    go,
    reload: () => {},
    openInNotes: () => {},
    me: "Seyi",
  };
  await act(async () => {
    root.render(createElement(AiActivity, props));
  });
}

describe("the Activity feed", () => {
  test("'Needs a person' hides every row without a person waiting on it", async () => {
    await render();
    expect(rows().length).toBe(3);
    expect(byTestId("admin-ai-activity-filter-needs")!.textContent).toContain("Needs a person (1)");

    await act(async () => byTestId("admin-ai-activity-filter-needs")!.click());

    expect(rows().length).toBe(1);
    expect(rows()[0]!.textContent).toContain("Drafted live-7");
    expect(rows()[0]!.textContent).toContain("needs a person");
    expect(container.textContent).not.toContain("Drafted live-8");
  });

  test("'Agents and people' cycles to Agents, and a setup's link opens its comparison", async () => {
    await render();
    await act(async () => byTestId("admin-ai-activity-filter-who")!.click());
    expect(byTestId("admin-ai-activity-filter-who")!.textContent).toContain("Agents ▾");
    expect(rows().length).toBe(1);

    await act(async () => byTestId("admin-ai-activity-link-0")!.click());
    expect(go).toHaveBeenCalledWith({ view: "jobs", job: "texting-assistant", tab: "setups", compare: "live-7" });
  });
});
