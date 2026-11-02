/**
 * @jest-environment jsdom
 */

/**
 * The tree draws where a drag would land: a line above or below a row for a
 * folder put in order (`TreeDropLine`), a wash for one going into a folder,
 * and nothing on rows the drag is not over.
 *
 * SABOTAGE (applied, run, reverted): drawing the line for `into` as well
 * fails "into washes the row and draws no line".
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => null,
  useAction: () => async () => null,
}));

const { FileTree } = require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
type Row = Parameters<typeof FileTree>[0]["rows"][number];

const row = (path: string, depth = 0): Row => ({
  kind: "folder",
  key: path,
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  label: path.slice(path.lastIndexOf("/") + 1),
  depth,
  expanded: false,
  selected: false,
  markerIsDefault: true,
  readOnly: false,
});

let root: Root | null = null;
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

function draw(dropTarget: { path: string; zone: "above" | "below" | "into" } | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(FileTree, {
        rows: [row("Projects"), row("Projects/alpha", 1), row("Areas")],
        onSelect: () => {},
        onToggle: () => {},
        dropTarget,
      }),
    ),
  );
  return (id: string) => document.querySelectorAll(`[data-testid="${id}"]`).length;
}

describe("where a drop would land, drawn", () => {
  test("above a row: one line, above", () => {
    const count = draw({ path: "Areas", zone: "above" });
    expect(count("tree-drop-above")).toBe(1);
    expect(count("tree-drop-below")).toBe(0);
  });

  test("below a nested row: one line, below", () => {
    const count = draw({ path: "Projects/alpha", zone: "below" });
    expect(count("tree-drop-below")).toBe(1);
    expect(count("tree-drop-above")).toBe(0);
  });

  test("into washes the row and draws no line", () => {
    const count = draw({ path: "Projects", zone: "into" });
    expect(count("tree-drop-above") + count("tree-drop-below")).toBe(0);
  });

  test("no drag, no line", () => {
    const count = draw(null);
    expect(count("tree-drop-above") + count("tree-drop-below")).toBe(0);
  });
});
