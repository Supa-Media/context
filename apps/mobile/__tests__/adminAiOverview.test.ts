/**
 * @jest-environment jsdom
 */

/**
 * The AI tab's overview, actually rendered (`features/admin/AiOverview.tsx`,
 * board 12). The owner, 2026-10-16: "every number opens the page behind it".
 * So these pin that the Jobs tile is drawn, and that "What worked, what
 * didn't" reads a scores note's table: a change that beat live shows its
 * points against live, to one decimal, and opens its comparison.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockPush = jest.fn();
const mockRead = jest.fn<(args: { path: string }) => Promise<unknown>>();
const mockWrite = jest.fn<(args: { path: string; text: string; expectedEtag?: string }) => Promise<unknown>>();

jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
// Stable functions, as Convex's own hooks return: a new one per render would re-run every effect.
const mockCloudflare = async () => ({ configured: false, workersAi: [], gateway: [], billedUsd: 0 });
jest.mock("convex/react", () => ({
  useQuery: () => undefined,
  useAction: (ref: unknown) => {
    const name = String((ref as { _name?: string })?._name ?? ref);
    if (name.includes("writeNote")) return mockWrite;
    if (name.includes("readNote")) return mockRead;
    return mockCloudflare;
  },
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
import { AiOverview, points } from "../features/admin/AiOverview";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";
import { readRun, type Candidate, type RunRead } from "../features/admin/aiModel";
import type { AiPlace } from "../features/admin/aiPlace";

const LIVE_SETUP = "---\njob: texting-assistant\nstatus: live\nmade_by: Seyi\n---\n\n# live-5\n";
const TEST = "---\njob: texting-assistant\n---\n\n# Core\n\n## 1. When's my dentist?\n\n- kind: task\n- must: say Tuesday at 3 pm\n";
const SCORES = [
  "---",
  "test: core",
  "---",
  "",
  "# 2026-10-14 core gh-33 scores",
  "",
  "## Scored by Judge, 2026-10-14",
  "",
  "| setup | score | gates | judge | price | speed | texts | errors | good enough |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| live-5 | 93.3% | passed | Haiku 5.5 | $0.009 | 2.1 s | 1 | 0 | yes |",
  "| live-6 | 100% | passed | Haiku 5.5 | $0.008 | 2.0 s | 1 | 0 | yes |",
  "",
].join("\n");
const RESULT_PATH = "ai/results/2026-10-14 core gh-33 scores.md";

const notes: FolderNote[] = [
  { path: "ai/production/texting-assistant.md", updatedAt: 1, props: JSON.stringify({ properties: { from: "live-5", live_since: "2026-10-13", promoted_by: "Seyi" }, heading: "Tex", lede: "" }) },
  { path: "ai/setups/texting-assistant/live-5.md", updatedAt: 2, props: JSON.stringify({ properties: { job: "texting-assistant", status: "live", made_by: "Seyi" }, heading: "live-5", lede: "" }) },
  { path: "ai/setups/texting-assistant/live-6.md", updatedAt: 3, props: JSON.stringify({ properties: { job: "texting-assistant", based_on: "live-5", change: "Never merge two to-dos", made_by: "improver", status: "beat live" }, heading: "live-6", lede: "" }) },
  { path: "ai/tests/core.md", updatedAt: 4, props: JSON.stringify({ properties: { job: "texting-assistant" }, heading: "Core", lede: "" }) },
  { path: RESULT_PATH, updatedAt: 5, props: JSON.stringify({ properties: { test: "core" }, heading: "2026-10-14 core gh-33 scores", lede: "" }) },
];

const catalog = buildCatalog(notes);
const reads: ReadonlyMap<string, RunRead> = new Map([[RESULT_PATH, readRun(SCORES)!]]);

let container: HTMLDivElement;
let root: Root;
let went: AiPlace[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockPush.mockClear();
  mockRead.mockReset();
  mockWrite.mockReset();
  mockRead.mockImplementation(async ({ path }) => ({ kind: "file", path, text: path.startsWith("ai/tests/") ? TEST : LIVE_SETUP, etag: "v1", readOnly: false }));
  mockWrite.mockImplementation(async ({ path }) => ({ kind: "written", path, etag: "v2" }));
  went = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render() {
  await act(async () => {
    root.render(
      createElement(AiOverview, {
        workspaceId: "ws" as never,
        catalog,
        reads,
        go: (place: AiPlace) => went.push(place),
        reload: () => {},
        openInNotes: () => {},
        me: "Seyi",
      }),
    );
  });
}

describe("the overview's tiles", () => {
  test("draws the Jobs tile with its count and the jobs with no cases in red", async () => {
    await render();
    const tile = byTestId("admin-ai-tile-jobs")!;
    expect(tile.textContent).toContain("Jobs");
    expect(tile.textContent).toContain(String(catalog.jobs.length));
    expect(tile.textContent).toContain(`${catalog.jobs.filter((row) => row.tests.length === 0).length} with no cases`);
  });

  test("the Jobs tile opens the jobs view", async () => {
    await render();
    await act(async () => byTestId("admin-ai-tile-jobs")!.click());
    expect(went).toContainEqual({ view: "jobs", job: null, tab: "overview", compare: null });
  });
});

describe("What worked, what didn't", () => {
  test("lists a change that beat live with its points, to one decimal", async () => {
    await render();
    const box = byTestId("admin-ai-changes")!;
    expect(box.textContent).toContain("What worked, what didn't");
    expect(box.textContent).toContain("Never merge two to-dos");
    expect(box.textContent).toContain("+6.7 pts");
  });

  test("a row opens that change beside live", async () => {
    await render();
    await act(async () => byTestId("admin-ai-change-live-6")!.click());
    expect(went).toContainEqual({ view: "jobs", job: "texting-assistant", tab: "setups", compare: "live-6" });
  });

  test("points rounds to one decimal and signs the difference against live", () => {
    const against = (score: number | null, live: number | null) =>
      ({ score: score === null ? null : { score }, liveScore: live === null ? null : { score: live } }) as unknown as Candidate;
    expect(points(against(100, 93.3))).toBe("+6.7 pts");
    expect(points(against(80, 100))).toBe("−20 pts");
    expect(points(against(100.02, 100))).toBe("0 pts");
    expect(points(against(100, null))).toBe("—");
  });

  test("a round with no 'Best setup' line names the best setup that was good enough", () => {
    expect(readRun(SCORES)!.best).toBe("live-6");
    expect(readRun(`${SCORES}\nBest setup that passes every bar: none.\n`)!.best).toBeNull();
  });

  test("live is not scored against itself: its row says — and never 0 pts", async () => {
    await render();
    const row = byTestId("admin-ai-change-live-5")!;
    expect(row.textContent).toContain("—");
    expect(row.textContent).not.toContain("0 pts");
    const self = { score: 93.3 };
    expect(points({ score: self, liveScore: self } as unknown as Candidate)).toBe("—");
  });
});
