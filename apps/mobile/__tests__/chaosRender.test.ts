/**
 * @jest-environment jsdom
 */

/**
 * THE CHAOS SCORE, ON THE GLASS.
 *
 * `chaosModel.test.ts` proves the words; this proves the surfaces draw them
 * and that each press lands: Tex at the tree's foot and the panel it opens, a
 * folder page's Tex and what it says, the phone Home's line, and the figure's eyes. And the
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
import { ChaosHomeLine } from "../features/chaos/ChaosHomeLine";
import { ChaosSheet } from "../features/chaos/ChaosPopover";
import { FolderTex } from "../features/chaos/FolderTex";
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

describe("the tree's foot line", () => {
  test("no score, or not scored yet: the foot is the one it always was", async () => {
    await mount(explorer());
    expect(byId("explorer-chaos")).toBeNull();
    await mount(explorer(), source(UNSCORED));
    expect(byId("explorer-chaos")).toBeNull();
    await mount(explorer(), source(null));
    expect(byId("explorer-chaos")).toBeNull();
    expect(byId("explorer-counts")).not.toBeNull();
  });

  test("Tex alone, no words: the score, its word and the way it went are its label", async () => {
    await mount(explorer(), source(SCORED));
    const line = byId("explorer-chaos");
    expect(strip(line?.textContent)).toBe("");
    expect(line?.getAttribute("aria-label")).toContain("Chaos 34 of 100, crowded");
    expect(line?.getAttribute("aria-label")).toContain(
      "down 7 from a week ago",
    );
    expect(line?.querySelector("svg")).not.toBeNull();
  });

  test("no trend without a week ago", async () => {
    await mount(explorer(), source({ ...SCORED, weekAgo: null }));
    expect(byId("explorer-chaos")?.getAttribute("aria-label")).not.toContain("week ago");
  });

  test("pressing it opens the panel over the tree, and pressing again closes it", async () => {
    await mount(explorer(), source(SCORED));
    expect(byId("chaos-panel")).toBeNull();
    await press(byId("explorer-chaos"));
    expect(byId("chaos-panel")).not.toBeNull();
    await press(byId("explorer-chaos"));
    expect(byId("chaos-panel")).toBeNull();
  });
});

describe("the panel", () => {
  test("says the score, a week ago, the biggest wins with their hints, long notes and how it's scored", async () => {
    await mount(explorer(), source(SCORED));
    await press(byId("explorer-chaos"));
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
  });

  test("reports and does not nag: no tidy button anywhere", async () => {
    await mount(explorer(), source(SCORED));
    await press(byId("explorer-chaos"));
    expect(strip(byId("chaos-panel")?.textContent).toLowerCase()).not.toMatch(
      /tidy|clean up|you should/,
    );
  });

  test("a folder or a note opens it, and the panel closes", async () => {
    const opened: string[] = [];
    await mount(explorer(), source(SCORED), opened);
    await press(byId("explorer-chaos"));
    await press(byId("chaos-win-0-inbox"));
    expect(opened).toEqual(["0-inbox"]);
    expect(byId("chaos-panel")).toBeNull();
    await press(byId("explorer-chaos"));
    await press(byId("chaos-long-2-areas/journal/2026.md"));
    expect(opened).toEqual(["0-inbox", "2-areas/journal/2026.md"]);
  });

  test("lists at most five wins", async () => {
    const folders = Array.from({ length: 8 }, (_, i) => ({
      folder: `f${i}`,
      items: 20,
      chaos: 65 - i,
    }));
    await mount(explorer(), source({ ...SCORED, folders }));
    await press(byId("explorer-chaos"));
    expect(
      document.querySelectorAll('[data-testid^="chaos-win-"]'),
    ).toHaveLength(5);
  });
});

describe("a folder page's Tex", () => {
  const tex = (folder = "0-inbox") => createElement(FolderTex, { folder });

  test("asks about its own folder, then Tex and its words: how many things, and what calm is", async () => {
    const asked: string[] = [];
    await mount(
      tex(),
      source(SCORED, { folder: "0-inbox", items: 12, chaos: 33 }, asked),
    );
    expect(asked).toEqual(["0-inbox"]);
    expect(byId("folder-tex-figure")?.querySelector("svg")).not.toBeNull();
    expect(byId("folder-tex-line")?.textContent).toBe("12 things in here · calm is 4 or 5");
  });

  test("a stressed Tex: it has hold of its yarn", async () => {
    await mount(
      tex(),
      source(SCORED, { folder: "0-inbox", items: 12, chaos: 33 }),
    );
    // The yarn is a path drawn only in the tugging pose.
    const paths = byId("folder-tex-figure")?.querySelectorAll("path").length ?? 0;
    const container = await mount(createElement(Tex, { chaos: 33, size: 40 }));
    expect(paths).toBe(container.querySelectorAll("path").length + 1);
  });

  test("thin says so", async () => {
    await mount(
      tex(),
      source(SCORED, { folder: "0-inbox", items: 2, chaos: 20 }),
    );
    expect(byId("folder-tex-line")?.textContent).toBe("Only 2 things in here · calm is 4 or 5");
  });

  test("a calm or fine folder, an unscored workspace, or no score: no Tex", async () => {
    await mount(
      tex(),
      source(SCORED, { folder: "0-inbox", items: 8, chaos: 15 }),
    );
    expect(byId("folder-tex")).toBeNull();
    await mount(
      tex(),
      source(UNSCORED, { folder: "0-inbox", items: 20, chaos: 65 }),
    );
    expect(byId("folder-tex")).toBeNull();
    await mount(tex());
    expect(byId("folder-tex")).toBeNull();
  });

  test("pressing Tex: it says how this folder could be calmer, and moves nothing", async () => {
    await mount(
      tex(),
      source(SCORED, { folder: "0-inbox", items: 12, chaos: 33 }),
    );
    expect(byId("folder-tex-talk")).toBeNull();
    await press(byId("folder-tex-figure"));
    const talk = strip(byId("folder-tex-talk")?.textContent);
    expect(talk).toContain("I'm holding 12 things. Folders feel calm with 4 or 5.");
    expect(talk).toContain("two to five themes");
    expect(talk).toContain("ask your AI to organize inbox");
    expect(talk.toLowerCase()).not.toMatch(/you should|tidy|clean up/);
  });

  test("from there, the whole workspace's score opens the panel", async () => {
    await mount(
      tex(),
      source(SCORED, { folder: "0-inbox", items: 12, chaos: 33 }),
    );
    await press(byId("folder-tex-figure"));
    await press(byId("folder-tex-whole"));
    expect(byId("folder-tex-talk")).toBeNull();
    expect(strip(byId("chaos-panel")?.textContent)).toContain(
      "Chaos 34 of 100",
    );
  });
});

describe("the phone's Home", () => {
  test("one quiet card with the score, opening the panel as a sheet", async () => {
    await mount(createElement(ChaosHomeLine), source(SCORED));
    const line = byId("phone-home-chaos");
    expect(strip(line?.textContent)).toContain("Chaos 34 · crowded");
    expect(strip(line?.textContent)).toContain("a week ago 41 ↓");
    await press(line);
    expect(byId("chaos-panel")).not.toBeNull();
  });

  test("not scored yet, or no score: nothing", async () => {
    await mount(createElement(ChaosHomeLine), source(UNSCORED));
    expect(byId("phone-home-chaos")).toBeNull();
    await mount(createElement(ChaosHomeLine));
    expect(byId("phone-home-chaos")).toBeNull();
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
