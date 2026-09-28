/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { useColumnTools } from "../../features/app/appFrame/columnTools";
import { mountFrame, space, styleOf, useFrame } from "./fixtures";

/**
 * THE FILE TREE'S TOOLS FILL THE ROW OVER IT.
 *
 * The title row above the tree held the sidebar toggle and nothing else, and
 * the owner called it a waste of space (2026-09-28). They chose to move the
 * tree's filter, new and view buttons up into it. The tree keeps their state,
 * and the frame draws them through `FrameApi.columnTools`.
 *
 * The tree here is a stand-in that does what `Explorer` does: it puts its
 * tools in the slot when there is one and draws them itself when there isn't.
 * `explorerChrome.spec.ts` does the same with the real tree in an engine.
 */
function Tree() {
  const frame = useFrame();
  const tools = createElement("span", { "data-testid": "tools" }, "filter new view");
  useColumnTools(frame.columnTools, frame.columnTools === null ? null : tools);
  return createElement(
    "div",
    { "data-testid": "explorer" },
    frame.columnTools === null ? tools : null,
    "tree",
  );
}

const inColumnHead = (frame: ReturnType<typeof mountFrame>) =>
  frame.find("frame-column-head")?.querySelector('[data-testid="tools"]') ?? null;
const inTree = (frame: ReturnType<typeof mountFrame>) =>
  frame.find("explorer")?.querySelector('[data-testid="tools"]') ?? null;

describe("the tree's tools", () => {
  test("sit in the title row over the column, and not at the column's head", () => {
    const frame = mountFrame(1440, "the note", { explorerNode: createElement(Tree) });
    expect(inColumnHead(frame)).not.toBeNull();
    expect(inTree(frame)).toBeNull();
    // Beside the tree's own toggle, in the same row.
    expect(frame.find("frame-column-head")?.querySelector('[data-testid="frame-toggle-explorer"]')).not.toBeNull();
    frame.unmount();
  });

  test("go back to the column's head when the tree is folded, and up again when it returns", () => {
    const frame = mountFrame(1440, "the note", { explorerNode: createElement(Tree) });
    act(() => frame.find("frame-toggle-explorer")!.click());
    expect(frame.find("frame-column-head")).toBeNull();
    expect(frame.container.querySelectorAll('[data-testid="tools"]').length).toBeLessThanOrEqual(1);
    expect(frame.find("app-top-bar")?.querySelector('[data-testid="tools"]') ?? null).toBeNull();

    act(() => frame.find("frame-toggle-explorer")!.click());
    expect(inColumnHead(frame)).not.toBeNull();
    expect(inTree(frame)).toBeNull();
    frame.unmount();
  });

  test("leave the title row when the tree unmounts", () => {
    const frame = mountFrame(1440, "the note", { explorerNode: createElement(Tree) });
    expect(inColumnHead(frame)).not.toBeNull();
    frame.unmount();
    const bare = mountFrame(1440);
    expect(bare.find("frame-column-head")?.querySelector('[data-testid="tools"]') ?? null).toBeNull();
    bare.unmount();
  });

  test("are never drawn in a phone's top row", () => {
    const frame = mountFrame(390, "the note", { explorerNode: createElement(Tree) });
    expect(frame.find("app-top-bar")?.querySelector('[data-testid="tools"]') ?? null).toBeNull();
    frame.unmount();
  });
});

describe("the first tab starts where the note does", () => {
  test("the column head takes back the bar's gap, so the tabs meet the column's edge", () => {
    // jsdom lays nothing out; the head is exactly the column's width, and this
    // is the one thing between it and the first tab.
    const frame = mountFrame(1440, "the note", { explorerNode: createElement(Tree) });
    expect(styleOf(frame.find("frame-column-head")!, "margin-right")).toBe(`-${space.x3}px`);
    frame.unmount();
  });
});
