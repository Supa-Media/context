/**
 * @jest-environment jsdom
 */

/**
 * THE CHAOS SCORE, ON THE GLASS.
 *
 * `chaosModel.test.ts` proves the words; this proves the surfaces draw them
 * and that each press lands: a folder page's line and its advice, the panel,
 * the phone Home's line, and that the app draws no Tex (Dev2, 2026-10-14: the
 * figure stays on the homepage only). The figure's own eyes and colours are
 * checked here too, for the homepage. And the
 * claim that matters for every workspace not scored yet: `available: false`
 * draws nothing at all, and neither does a console with no score.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import type { FileBrowser } from "../features/console/files/browser";
import { ChaosProvider, useConsoleChaos } from "../features/chaos/ChaosContext";
import { Tex } from "../features/chaos/Tex";
import { texColors } from "../features/design/tokens/landingColors";
import { ChaosSheet } from "../features/chaos/ChaosPopover";
import { FolderChaosLine } from "../features/chaos/FolderChaosLine";
import type { ChaosScore } from "../features/chaos/chaosModel";
import type { ChaosSource } from "../features/chaos/useChaosScore";

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 1280, height: 900 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const strip = (text: string | null | undefined): string =>
  (text ?? "").replace(/[\u2066-\u2069]/g, "");

const SCORED: ChaosScore = {
  kind: "chaosScore",
  available: true,
  score: 34,
  word: "crowded",
  weekAgo: 41,
  folders: [
    { folder: "0-inbox", items: 23, chaos: 76 },
    { folder: "3-resources/books", items: 2, chaos: 20 },
    { folder: "2-areas/empty", items: 0, chaos: 60 },
  ],
  longNotes: [{ path: "2-areas/journal/2026.md", lines: 1420 }],
  folder: null,
};
const UNSCORED: ChaosScore = {
  ...SCORED,
  available: false,
  score: null,
  word: null,
  weekAgo: null,
  folders: [],
  longNotes: [],
};

function source(
  result: ChaosScore | null,
  folder: ChaosScore["folder"] = null,
  asked: string[] = [],
): ChaosSource {
  return {
    result,
    version: 1,
    folderScore: async (name) => {
      asked.push(name);
      return result === null ? null : { ...result, folder };
    },
    refresh: () => {},
  };
}

/** The layout's provider, with its real panel state, around `children`. */
function Harness({
  src,
  opened,
  children,
}: {
  src: ChaosSource | undefined;
  opened: string[];
  children: ReactNode;
}) {
  const view = useConsoleChaos(src, (path) => opened.push(path));
  return createElement(
    ChaosProvider,
    { value: view },
    children,
    createElement(ChaosSheet),
  );
}

function browser(): FileBrowser {
  return {
    canEdit: true,
    contextId: "w1",
    loading: false,
    busy: false,
    listings: {
      "": { path: "", entries: [], manifestUsable: true, truncated: false },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    collapseAll: () => {},
    selectedPath: null,
    opening: null,
    select: () => true,
    deselect: () => true,
    say: () => {},
  } as unknown as FileBrowser;
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

async function mount(
  element: ReactElement,
  src?: ChaosSource,
  opened: string[] = [],
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const inner =
    src === undefined
      ? element
      : createElement(Harness, { src, opened, children: element });
  await act(async () => {
    root.render(
      createElement(SafeAreaProvider, { initialMetrics: METRICS }, inner),
    );
  });
  return container;
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const press = async (element: Element | null) => {
  if (element === null) throw new Error("nothing to press");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const explorer = () =>
  createElement(Explorer, { files: browser(), contextLabel: "@seyi" });

const line = (folder = "0-inbox") => createElement(FolderChaosLine, { folder });
const crowded = { folder: "0-inbox", items: 12, chaos: 33 };

/** The workspace's panel, reached the one way a wide window has: a folder's line, its advice, the whole score. */
async function openPanel(opened: string[] = [], result: ChaosScore = SCORED) {
  await mount(line(), source(result, crowded), opened);
  await press(byId("folder-chaos-line"));
  await press(byId("folder-chaos-whole"));
}

describe("the tree's foot", () => {
  test("has no chaos line, scored or not: Tex is gone from the app", async () => {
    for (const src of [undefined, source(UNSCORED), source(null), source(SCORED)]) {
      await mount(explorer(), src);
      expect(byId("explorer-chaos")).toBeNull();
      expect(byId("explorer-counts")).not.toBeNull();
    }
  });
});

describe("the panel", () => {
  test("says the score, a week ago, the biggest wins with their hints, long notes and how it's scored", async () => {
    await openPanel();
    const panel = strip(byId("chaos-panel")?.textContent);
    expect(panel).toContain("Chaos 34 of 100");
    expect(panel).toContain("crowded");
    expect(panel).toContain("a week ago 41 ↓");
    expect(panel).toContain("Biggest wins");
    expect(panel).toContain("inbox");
    expect(panel).toContain("23 items");
    expect(panel).toContain("chaotic: calm is 4 to 5, 10 is average");
    expect(panel).toContain("thin: calm is 4 to 5");
    expect(panel).toContain("only its about note");
    expect(panel).toContain("Long notes");
    expect(panel).toContain("1,420 lines");
    expect(panel).toContain("How it’s scored");
    expect(panel).toContain("Archive is never scored");
    expect(byId("chaos-panel")?.querySelector("svg")).toBeNull();
  });

  test("reports and does not nag: no tidy button anywhere", async () => {
    await openPanel();
    expect(strip(byId("chaos-panel")?.textContent).toLowerCase()).not.toMatch(
      /tidy|clean up|you should/,
    );
  });

  test("a folder or a note opens it, and the panel closes", async () => {
    const opened: string[] = [];
    await openPanel(opened);
    await press(byId("chaos-win-0-inbox"));
    expect(opened).toEqual(["0-inbox"]);
    expect(byId("chaos-panel")).toBeNull();
    await press(byId("folder-chaos-line"));
    await press(byId("folder-chaos-whole"));
    await press(byId("chaos-long-2-areas/journal/2026.md"));
    expect(opened).toEqual(["0-inbox", "2-areas/journal/2026.md"]);
  });

  test("lists at most five wins", async () => {
    const folders = Array.from({ length: 8 }, (_, i) => ({
      folder: `f${i}`,
      items: 20,
      chaos: 65 - i,
    }));
    await openPanel([], { ...SCORED, folders });
    expect(
      document.querySelectorAll('[data-testid^="chaos-win-"]'),
    ).toHaveLength(5);
  });
});

describe("a folder page's line", () => {
  test("asks about its own folder, then one plain line: how many things, and what calm is", async () => {
    const asked: string[] = [];
    await mount(line(), source(SCORED, crowded, asked));
    expect(asked).toEqual(["0-inbox"]);
    expect(byId("folder-chaos-line")?.textContent).toBe("12 things in here · calm is 4 or 5");
  });

  test("words only: no figure", async () => {
    await mount(line(), source(SCORED, crowded));
    expect(byId("folder-chaos")?.querySelector("svg")).toBeNull();
  });

  test("thin says so", async () => {
    await mount(
      line(),
      source(SCORED, { folder: "0-inbox", items: 2, chaos: 20 }),
    );
    expect(byId("folder-chaos-line")?.textContent).toBe("Only 2 things in here · calm is 4 or 5");
  });

  test("a calm or fine folder, an unscored workspace, or no score: no line", async () => {
    await mount(
      line(),
      source(SCORED, { folder: "0-inbox", items: 8, chaos: 15 }),
    );
    expect(byId("folder-chaos")).toBeNull();
    await mount(
      line(),
      source(UNSCORED, { folder: "0-inbox", items: 20, chaos: 65 }),
    );
    expect(byId("folder-chaos")).toBeNull();
    await mount(line());
    expect(byId("folder-chaos")).toBeNull();
  });

  test("pressing it: how this folder could be calmer, with no figure, and nothing moves", async () => {
    await mount(line(), source(SCORED, crowded));
    expect(byId("folder-chaos-advice")).toBeNull();
    await press(byId("folder-chaos-line"));
    const advice = byId("folder-chaos-advice");
    const words = strip(advice?.textContent);
    expect(words).toContain("12 things in here. Folders feel calm with 4 or 5.");
    expect(words).toContain("two to five themes");
    expect(words).toContain("ask your AI to organize inbox");
    expect(words.toLowerCase()).not.toMatch(/you should|tidy|clean up/);
    expect(advice?.querySelector("svg")).toBeNull();
  });

  test("from there, the whole workspace's score opens the panel", async () => {
    await openPanel();
    expect(byId("folder-chaos-advice")).toBeNull();
    expect(strip(byId("chaos-panel")?.textContent)).toContain(
      "Chaos 34 of 100",
    );
  });
});

describe("the figure", () => {
  const figure = (chaos: number, size = 120) =>
    createElement(Tex, { chaos, size, testID: "fig" });
  const within = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="${id}"]`);

  test("googly eyes at 0 and at 1: one Tex, calm or not", async () => {
    for (const chaos of [0, 1]) {
      const drawn = await mount(figure(chaos));
      expect(within(drawn, "fig-googly")).not.toBeNull();
      expect(within(drawn, "fig-dots")).toBeNull();
    }
  });

  test("Tex's blue, lifted in dark mode", async () => {
    const light = await mount(
      createElement(Tex, { chaos: 50, size: 120, scheme: "light" }),
    );
    expect(light.querySelector("path")?.getAttribute("stroke")).toBe(
      texColors.light.ink,
    );
    const dark = await mount(
      createElement(Tex, { chaos: 50, size: 120, scheme: "dark" }),
    );
    expect(dark.querySelector("path")?.getAttribute("stroke")).toBe(
      texColors.dark.ink,
    );
  });

  test("the brush edge in a browser, and plain strokes when tiny", async () => {
    const big = await mount(figure(60));
    expect(within(big, "chaos-figure-rough")).not.toBeNull();
    expect(big.querySelector("filter")?.innerHTML.toLowerCase()).toContain(
      "fedisplacementmap",
    );
    const tiny = await mount(figure(60, 18));
    expect(within(tiny, "chaos-figure-rough")).toBeNull();
    expect(tiny.querySelector("svg")).not.toBeNull();
  });
});
