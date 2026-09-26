/**
 * @jest-environment jsdom
 */

/**
 * The homepage's writable workspace, driven the way the Explorer drives it:
 * what is open follows a note through a rename, a page opened by address is
 * the note that page now is, and the site stops rewriting the tree the moment
 * the visitor has changed it.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { liveHomeTree, type HomeTree } from "../features/home/homeSite";
import { useLocalFileBrowser, type LocalHome, type LocalHomeEvents } from "../features/home/useLocalFileBrowser";

const SITE = [
  { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome" },
  { path: "pricing.md", routePath: "/pricing", title: "Pricing", markdown: "# Pricing" },
];

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(home: HomeTree, route: string, events: LocalHomeEvents = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const seen: { current: LocalHome | null } = { current: null };
  function Probe(props: { home: HomeTree; route: string }) {
    seen.current = useLocalFileBrowser(props.home, "home", props.route, events);
    return null;
  }
  const render = (next: HomeTree, at: string) => act(() => root.render(createElement(Probe, { home: next, route: at })));
  render(home, route);
  cleanup = () => act(() => root.unmount());
  return { get: () => seen.current!, render };
}

describe("the homepage's workspace, kept in the tab", () => {
  test("the page the address names is open on the first render", () => {
    const view = mount(liveHomeTree(SITE), "/pricing");
    expect(view.get().files.selectedPath).toBe("02-Pricing.md");
    expect(view.get().files.editor.draft).toBe("# Pricing");
    expect(view.get().files.canEdit).toBe(true);
  });

  test("a new note opens, and typing in it changes the tree", () => {
    const created = jest.fn();
    const view = mount(liveHomeTree(SITE), "/", { onCreated: created });
    act(() => view.get().files.createNote("", "ideas"));
    expect(created).toHaveBeenCalledWith("ideas.md");
    expect(view.get().files.selectedPath).toBe("ideas.md");
    act(() => view.get().files.setDraft("# Ideas"));
    expect(view.get().notes["ideas.md"]).toBe("# Ideas");
    expect(view.get().touched).toBe(true);
  });

  test("a renamed page stays open and keeps its address", () => {
    const moved = jest.fn();
    const home = liveHomeTree(SITE);
    const view = mount(home, "/pricing", { onMoved: moved });
    act(() => view.get().files.rename("02-Pricing.md", "Plans"));
    expect(view.get().files.selectedPath).toBe("Plans.md");
    expect(view.get().files.editor.path).toBe("Plans.md");
    expect(moved).toHaveBeenCalledWith([["02-Pricing.md", "Plans.md"]]);
    expect(view.get().pathOf("/pricing")).toBe("Plans.md");
    view.render(home, "/");
    view.render(home, "/pricing");
    expect(view.get().files.selectedPath).toBe("Plans.md");
  });

  test("deleting the open note closes it and says which notes went", () => {
    const removed = jest.fn();
    const view = mount(liveHomeTree(SITE), "/pricing", { onRemoved: removed });
    act(() => view.get().files.destroy("02-Pricing.md"));
    expect(view.get().files.selectedPath).toBeNull();
    expect(view.get().notes["02-Pricing.md"]).toBeUndefined();
    expect(removed).toHaveBeenCalledWith(["02-Pricing.md"]);
  });

  test("the site's edits arrive until the visitor has changed something, then stop", () => {
    const view = mount(liveHomeTree(SITE), "/");
    view.render(liveHomeTree([{ ...SITE[0]!, markdown: "# Hello" }, SITE[1]!]), "/");
    expect(view.get().notes["01-Welcome.md"]).toBe("# Hello");
    expect(view.get().files.editor.draft).toBe("# Hello");
    act(() => view.get().files.createFolder("", "Mine"));
    view.render(liveHomeTree([{ ...SITE[0]!, markdown: "# Later" }, SITE[1]!]), "/");
    expect(view.get().notes["01-Welcome.md"]).toBe("# Hello");
    expect(view.get().files.listings.Mine).toBeDefined();
  });
});
