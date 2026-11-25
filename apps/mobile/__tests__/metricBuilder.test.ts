/**
 * @jest-environment jsdom
 */

/**
 * The metric builder drawn (boards 04 and 04b): the footer names the note it will write as the name is typed, the
 * preview is worked out from the reader's own sheets, the formula box offers the columns that fit the word being
 * typed and puts a picked one in its place, and Save writes the one note the draft reads as, or says why not.
 *
 * SABOTAGE: make `MetricBuilder.tsx` save `metricNoteText({...draft, every: "week"})` → "Save writes the note the
 * draft reads as" fails; make `columnSuggestions` ignore the dot → "after a dataset and a dot" fails here and in
 * `metricDraft.test.ts`.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
}));

import { ThemeProvider } from "../features/design/theme";
import { MetricBuilderDialog } from "../features/console/files/data/MetricBuilder";
import { metricOf } from "../features/console/files/data/metrics";
import { properties, splitNote } from "../features/console/files/frontmatter";
import type { DataSource } from "../features/console/files/data/sources";
import type { Sheet } from "../features/console/files/data/workOut";

const NOW = Date.parse("2026-11-25T11:00:00Z");
const cloudflare: DataSource = {
  folder: "data/cloudflare",
  slug: "cloudflare",
  kind: "cloudflare",
  name: "Cloudflare",
  aboutPath: "data/cloudflare/about.md",
  about: null,
  datasets: [{ name: "ai-spend", path: "data/cloudflare/ai-spend.csv", computed: false }],
};
const sheets = new Map<string, Sheet | null>([
  [
    "data/cloudflare/ai-spend.csv",
    {
      columns: [{ name: "date", type: "date" }, { name: "usd", type: "number" }, { name: "service", type: "text" }],
      rows: [
        { date: "2026-11-02T00:00:00Z", usd: "4", service: "ai" },
        { date: "2026-11-20T00:00:00Z", usd: "6", service: "ai" },
        { date: "2026-10-10T00:00:00Z", usd: "3", service: "ai" },
      ],
    },
  ],
]);

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function mount(onSave: (path: string, text: string) => Promise<string | null>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      h(
        ThemeProvider,
        null,
        h(MetricBuilderDialog, {
          metricsFolder: "data/metrics",
          taken: new Set(["data/metrics/ai-spend.md"]),
          sources: [cloudflare],
          sheets,
          startFormula: "count(cloudflare/ai-spend.date)",
          sheet: false,
          now: NOW,
          onSave,
          onClose: () => {},
        }),
      ),
    );
  });
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const type = async (id: string, value: string) => {
  const input = byId(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("select", { bubbles: true }));
  });
};
const press = async (id: string) => {
  await act(async () => {
    byId(id)!.click();
  });
};
const props = (text: string) => Object.fromEntries(properties(splitNote(text).frontmatter).map((row) => [row.key, row.value]));

describe("the metric builder", () => {
  test("names the note it writes as the name is typed, never one that is there", async () => {
    await mount(async () => null);
    expect(byId("metric-lands")!.textContent).toContain("data/metrics/new-metric.md");
    await type("metric-name", "AI spend");
    expect(byId("metric-lands")!.textContent).toContain("data/metrics/ai-spend-2.md");
    expect(byId("metric-lands")!.textContent).toContain("worked out as you read");
  });

  test("previews the period so far from the reader's own sheets", async () => {
    await mount(async () => null);
    await type("metric-name", "AI spend");
    await press("metric-edit-toggle");
    await type("metric-formula", "sum(cloudflare/ai-spend.usd)");
    expect(byId("metric-preview")!.textContent).toContain("10");
    expect(byId("metric-preview")!.textContent).toContain("this month, so far");
    await press("metric-every-week");
    expect(byId("metric-preview")!.textContent).toContain("Last 6 weeks");
  });

  test("after a dataset and a dot, offers its columns, and a picked one takes the word's place", async () => {
    await mount(async () => null);
    await press("metric-edit-toggle");
    await type("metric-formula", "sum(cloudflare/ai-spend.u");
    const list = byId("metric-suggestions");
    expect(list?.textContent).toContain("Columns in Cloudflare ai-spend");
    expect(byId("metric-suggestion-1")).toBeNull();
    await press("metric-suggestion-0");
    expect((byId("metric-formula") as HTMLInputElement).value).toBe("sum(cloudflare/ai-spend.usd");
  });

  test("Save writes the note the draft reads as", async () => {
    const saved: { path: string; text: string }[] = [];
    await mount(async (path, text) => {
      saved.push({ path, text });
      return null;
    });
    await type("metric-name", "Spend per day");
    await press("metric-every-day");
    await type("metric-format", "$0.00");
    await press("metric-save");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.path).toBe("data/metrics/spend-per-day.md");
    const metric = metricOf({ path: saved[0]!.path, properties: props(saved[0]!.text) });
    expect(metric).toMatchObject({ name: "Spend per day", formula: "count(cloudflare/ai-spend.date)", every: "day", format: "$0.00" });
  });

  test("won't save without a name or with a formula that doesn't read, and says why", async () => {
    const saved: string[] = [];
    await mount(async (path) => {
      saved.push(path);
      return null;
    });
    await press("metric-save");
    expect(byId("metric-problem")!.textContent).toBe("Give it a name.");
    await type("metric-name", "Broken");
    await press("metric-edit-toggle");
    await type("metric-formula", "sum(cloudflare/ai-spend.usd");
    await press("metric-save");
    expect(byId("metric-problem")!.textContent).toMatch(/\S/);
    expect(saved).toEqual([]);
  });

  test("a failed write is said, and the dialog stays", async () => {
    await mount(async () => "The metric could not be saved. Try again.");
    await type("metric-name", "Spend");
    await press("metric-save");
    expect(byId("metric-problem")!.textContent).toBe("The metric could not be saved. Try again.");
  });
});
