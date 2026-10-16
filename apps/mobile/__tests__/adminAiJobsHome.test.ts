/**
 * @jest-environment jsdom
 */

/**
 * The AI tab's home, actually rendered (`features/admin/AiJobsHome.tsx`, board
 * 8). A job's row says what is live and how it scores, and its one next step
 * is a link: a setup that beat live waits for a person's yes under "Needs your
 * yes", and the row and the card both open the comparison, never a promotion.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
// A desktop width: below the narrow breakpoint the rows are the phone's two-line form, and the table is not drawn.
jest.mock("react-native", () => ({
  ...jest.requireActual<typeof import("react-native")>("react-native"),
  useWindowDimensions: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
}));
// Stable functions, as Convex's own hooks return: a new one per render would re-run every effect.
const mockCloudflare = async () => ({ configured: false, workersAi: [], gateway: [], billedUsd: 0 });
jest.mock("convex/react", () => ({
  useQuery: () => undefined,
  useAction: (ref: unknown) => {
    const name = String((ref as { _name?: string })?._name ?? ref);
    if (name.includes("writeNote")) return async () => ({ kind: "written", path: "", etag: "v2" });
    if (name.includes("readNote")) return async () => ({ kind: "file", path: "", text: "", etag: "v1", readOnly: false });
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
import { AiJobsHome } from "../features/admin/AiJobsHome";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";
import { readRun, type RunRead } from "../features/admin/aiModel";
import type { AiPlace } from "../features/admin/aiPlace";

const RESULT = "ai/results/2026-10-14 core gh-33 scores.md";

/** live-5 fell on case 5; live-6 passed every case and is good enough. */
const SCORES = [
  "## Scored by claude-haiku-5-5, 2026-10-14",
  "",
  "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| live-5 | 93.3% | failed (q5) | 14 | $0.02 | 3.1 s | 12 | 0 | no |",
  "| live-6 | 100% | passed | 14 | $0.02 | 3.4 s | 12 | 0 | yes |",
  "",
].join("\n");

const notes: FolderNote[] = [
  {
    path: "ai/production/texting-assistant.md",
    size: 27661,
    props: JSON.stringify({ properties: { from: "live-5", live_since: "2026-10-14", models: { main: "anthropic/claude-haiku-5-5" } }, heading: "Tex", lede: "" }),
  },
  { path: "ai/tests/core.md", props: JSON.stringify({ properties: { job: "texting-assistant" }, heading: "Core", lede: "" }) },
  {
    path: "ai/setups/texting-assistant/live-5.md",
    size: 27661,
    props: JSON.stringify({ properties: { made_by: "improver" }, heading: "live-5", lede: "" }),
  },
  {
    path: "ai/setups/texting-assistant/live-6.md",
    size: 27600,
    props: JSON.stringify({ properties: { based_on: "live-5", change: "Never merge two to-dos", made_by: "improver" }, heading: "live-6", lede: "" }),
  },
  { path: RESULT, props: JSON.stringify({ properties: {}, heading: "", lede: "" }) },
];

const reads = new Map<string, RunRead>([[RESULT, readRun(SCORES)!]]);

let container: HTMLDivElement;
let root: Root;
let mockGo: jest.Mock<(place: AiPlace) => void>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockPush.mockClear();
  mockGo = jest.fn<(place: AiPlace) => void>();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render() {
  await act(async () => {
    root.render(
      createElement(AiJobsHome, {
        workspaceId: "ws" as never,
        catalog: buildCatalog(notes),
        reads,
        go: mockGo,
        reload: () => {},
        openInNotes: () => {},
        me: "Maya",
      }),
    );
  });
}

describe("the jobs home", () => {
  test("Tex's row shows the live setup, its score and the one next step", async () => {
    await render();
    const tex = byTestId("admin-ai-job-texting-assistant")!;
    expect(tex.textContent).toContain("Tex, by text");
    expect(tex.textContent).toContain("Haiku 5.5");
    expect(tex.textContent).toContain("live-5");
    expect(tex.textContent).toContain("93.3%");
    expect(tex.textContent).toContain("1 case fell");
    expect(tex.textContent).toContain("6.9k");
    expect(tex.textContent).toContain("Review 1 experiment");
  });

  test("a job with no setup says so in its live column and offers its first test", async () => {
    await render();
    const app = byTestId("admin-ai-job-app-assistant")!;
    expect(app.textContent).toContain("no note");
    expect(app.textContent).toContain("Write its first test");
  });

  test("a row opens the job's overview", async () => {
    await render();
    await act(async () => byTestId("admin-ai-job-texting-assistant")!.click());
    expect(mockGo).toHaveBeenCalledWith({ view: "jobs", job: "texting-assistant", tab: "overview", compare: null });
  });

  test("the review link opens the candidate beside live", async () => {
    await render();
    await act(async () => byTestId("admin-ai-job-texting-assistant-next")!.click());
    expect(mockGo).toHaveBeenLastCalledWith({ view: "jobs", job: "texting-assistant", tab: "setups", compare: "live-6" });
  });

  test("the improver button opens its helper, and changes nothing", async () => {
    await render();
    await act(async () => byTestId("admin-ai-improver")!.click());
    expect(mockGo).toHaveBeenCalledWith({ view: "helpers", helper: "improver" });
  });
});

describe("needs your yes", () => {
  test("a candidate that beat live is a card with both scores and the size change", async () => {
    await render();
    const card = byTestId("admin-ai-needs-yes")!;
    expect(card.textContent).toContain("Tex, by text: live-6 beats live-5");
    expect(card.textContent).toContain("100% vs 93.3% on core, −15 tokens");
    expect(byTestId("admin-ai-yes-count")!.textContent).toBe("1");
  });

  test("Compare opens the experiment, it does not make it live", async () => {
    await render();
    await act(async () => byTestId("admin-ai-yes-live-6-compare")!.click());
    expect(mockGo).toHaveBeenLastCalledWith({ view: "jobs", job: "texting-assistant", tab: "setups", compare: "live-6" });
  });
});

describe("overnight", () => {
  test("the activity that ran on its own is listed, and Activity opens the tab", async () => {
    await render();
    const overnight = byTestId("admin-ai-overnight")!;
    expect(overnight.textContent).toContain("Improver");
    expect(overnight.textContent).toContain("Ran core");
    await act(async () => byTestId("admin-ai-overnight-link")!.click());
    expect(mockGo).toHaveBeenLastCalledWith({ view: "activity" });
  });
});
