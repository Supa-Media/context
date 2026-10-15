/**
 * @jest-environment jsdom
 *
 * A FOLDER PAGE EASES WHAT LOADS LATE, AND WHAT IS ADDED OR DELETED.
 *
 * The owner, 2026-10-14: "When the about content loads in a folder,
 * everything is jumpy, can we have smooth animnations on the page whenever
 * something loads in late? or whenever a note is deleted or added?"
 *
 *  1. `Settle` eases a block to each new height its content takes, after
 *     drawing the first one at once — the folder page's head, whose chaos
 *     line, status line and about answer one at a time.
 *  2. `useDepartures` keeps a row that was just deleted in its place while it
 *     closes, by `useArrivals`' rules: not a rename, not a folder's worth.
 *  3. In a folder's listing, a deleted note closes rather than vanishing, and
 *     a note added while the folder is open eases in.
 *
 * SABOTAGE: write nothing in `Settle`'s observer and 1 fails; return `items`
 * from `useDepartures` unchanged and 2 and 3's deletion fail; drop the
 * "something also arrived" check and "a rename is not a departure" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileEntry, FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no `matchMedia`, where RN-Web reads reduced motion: answer "no preference".
window.matchMedia = ((media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// Nor a `ResizeObserver`: one that is called by hand, as a browser would after layout.
const observers: (() => void)[] = [];
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    observers.push(this.callback);
  }
  unobserve() {}
  disconnect() {
    const at = observers.indexOf(this.callback);
    if (at >= 0) observers.splice(at, 1);
  }
};

const { Settle } = require("../features/design/components/Settle") as typeof import("../features/design/components/Settle");
const { useDepartures } = require("../features/design/useDepartures") as typeof import("../features/design/useDepartures");
const { MAX_ARRIVALS } = require("../features/design/useArrivals") as typeof import("../features/design/useArrivals");
const { motion } = require("../features/design/tokens/motion") as typeof import("../features/design/tokens/motion");
const { FolderView } = require("../features/console/files/FolderView") as typeof import("../features/console/files/FolderView");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  observers.length = 0;
  jest.useRealTimers();
});

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

async function rerender(node: ReactNode) {
  await act(async () => root!.render(node));
}

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("Settle", () => {
  const settle = () => createElement(Settle, { testID: "settle" }, createElement("span", null, "words"));
  const box = () => host!.querySelector<HTMLElement>('[data-testid="settle"]')!;
  const contentHeight = (px: number) =>
    Object.defineProperty(box().firstElementChild!, "offsetHeight", { value: px, configurable: true });

  test("takes its content's height, and eases to every new one", async () => {
    await mount(settle());
    expect(box().style.transition).toContain(`height ${motion.layoutMs}ms`);
    contentHeight(20);
    act(() => observers.forEach((each) => each()));
    expect(box().style.height).toBe("20px");
    contentHeight(64);
    act(() => observers.forEach((each) => each()));
    expect(box().style.height).toBe("64px");
  });

  test("clips only up and down, so a tint past the column's edge still shows", async () => {
    await mount(settle());
    expect(box().style.overflowY).toBe("clip");
    expect(box().style.overflowX).toBe("visible");
  });
});

describe("useDepartures", () => {
  let latest: { items: readonly string[]; leaving: ReadonlySet<string> } = { items: [], leaving: new Set() };
  function Probe({ keys }: { keys: readonly string[] }) {
    latest = useDepartures(keys, (key) => key);
    return null;
  }
  const probe = (keys: readonly string[]) => createElement(Probe, { keys });

  test("the first load keeps nothing", async () => {
    await mount(probe(["a", "b"]));
    expect(latest.items).toEqual(["a", "b"]);
    expect([...latest.leaving]).toEqual([]);
  });

  test("a deleted row stays where it was while it closes, then goes", async () => {
    jest.useFakeTimers();
    await mount(probe(["a", "gone", "b"]));
    await rerender(probe(["a", "b"]));
    expect(latest.items).toEqual(["a", "gone", "b"]);
    expect([...latest.leaving]).toEqual(["gone"]);
    await wait(motion.layoutMs);
    expect(latest.items).toEqual(["a", "b"]);
    expect([...latest.leaving]).toEqual([]);
  });

  test("the first row, deleted, stays first", async () => {
    await mount(probe(["gone", "a"]));
    await rerender(probe(["a"]));
    expect(latest.items).toEqual(["gone", "a"]);
  });

  test("a rename is not a departure", async () => {
    await mount(probe(["a", "b"]));
    await rerender(probe(["a", "c"]));
    expect(latest.items).toEqual(["a", "c"]);
  });

  test("a whole folder's worth at once is not", async () => {
    const many = Array.from({ length: MAX_ARRIVALS + 1 }, (_, i) => `n${i}`);
    await mount(probe(["a", ...many]));
    await rerender(probe(["a"]));
    expect(latest.items).toEqual(["a"]);
  });

  test("a row that comes back while closing is simply there again", async () => {
    jest.useFakeTimers();
    await mount(probe(["a", "b"]));
    await rerender(probe(["a"]));
    await rerender(probe(["a", "b"]));
    expect(latest.items).toEqual(["a", "b"]);
    expect([...latest.leaving]).toEqual([]);
    await wait(motion.layoutMs);
    expect(latest.items).toEqual(["a", "b"]);
  });
});

describe("a folder's listing", () => {
  const ROOT = "1-projects";
  const at = (path: string): FileEntry => ({
    kind: "file",
    path,
    name: path.split("/").pop()!,
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  });
  const listing = (names: readonly string[]): FolderListing => ({
    path: ROOT,
    folderDefault: "team",
    entries: names.map((name) => at(`${ROOT}/${name}.md`)),
    truncated: false,
    manifestUsable: true,
  });
  const view = (names: readonly string[]) =>
    createElement(FolderView, {
      entry: { ...at(ROOT), kind: "folder" },
      listing: listing(names),
      canSetVisibility: true,
      contextLabel: "@seyi",
      onSelect: () => {},
    });
  const row = (name: string) => host!.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  // The Reveal a row is drawn in: its grid row is `1fr` open, `0fr` closing.
  const roomOf = (name: string) => row(name)?.closest<HTMLElement>('[style*="grid-template-rows"]') ?? null;

  test("a deleted note closes in place rather than vanishing", async () => {
    jest.useFakeTimers();
    await mount(view(["budget", "lease", "menu"]));
    await rerender(view(["budget", "menu"]));
    expect(row("lease")).not.toBeNull();
    expect(roomOf("lease")?.style.gridTemplateRows).toBe("0fr");
    await wait(motion.layoutMs);
    expect(row("lease")).toBeNull();
    expect(row("menu")).not.toBeNull();
  });

  test("a note added while the folder is open eases in", async () => {
    await mount(view(["budget", "menu"]));
    // The rows it opened with are at rest: unclipped.
    expect((roomOf("budget")?.firstElementChild as HTMLElement).style.overflowY).toBe("");
    await rerender(view(["budget", "lease", "menu"]));
    // The new one is still growing into its room, clipped while it moves.
    expect(roomOf("lease")?.style.gridTemplateRows).toBe("1fr");
    expect((roomOf("lease")?.firstElementChild as HTMLElement).style.overflowY).toBe("hidden");
  });
});
