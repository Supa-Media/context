/**
 * @jest-environment jsdom
 */

/**
 * A folder's row in the tree leaves Agent Mail, the map and the trash, as a note's row does.
 *
 * A folder's row toggles rather than selects, and only the select path left the full pages, so with Agent Mail open
 * a click on "bots" changed nothing on screen (Dev, 2026-11-26: "I clicked on the bots folder on the left and it did
 * not go back to the bots screen"). See `ExplorerTree.tsx` and `layout/leaveFullPage.ts`.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { ExplorerTree } from "../features/console/files/explorer/ExplorerTree";
import { MailRouteProvider } from "../features/console/mailPage/MailRouteContext";
import type { TreeRow } from "../features/console/files/tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

const row = (kind: "folder" | "file", path: string): TreeRow => ({
  kind, key: path, path, name: path, label: path, depth: 0,
  expanded: false, selected: true, markerIsDefault: true, readOnly: false,
});

function mount(rows: TreeRow[], mailOpen: boolean) {
  const did: string[] = [];
  const files = {
    loading: false,
    titleEdit: undefined,
    selectedPath: "bots",
    contextId: "ws-1",
    iconOf: () => null,
    select: (path: string) => did.push(`select ${path}`),
    toggleFolder: (path: string) => did.push(`toggle ${path}`),
    listings: {},
  };
  const mail = {
    open: mailOpen,
    workspaceId: "ws-1",
    openMail: () => {},
    openThread: () => {},
    closeMail: () => did.push("close mail"),
    toggle: () => {},
  };
  const tree = createElement(ExplorerTree, {
    files,
    query: "",
    contextLabel: "@seyi",
    matches: null,
    rows,
    select: (path: string) => did.push(`select ${path}`),
    setPicked: () => {},
    openMenu: () => {},
    onPick: () => {},
    dragHandlers: undefined,
    dropTarget: null,
    markedPaths: undefined,
    agentMarks: undefined,
    background: { ref: createRef() },
  } as never);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(MailRouteProvider, { value: mail }, tree)));
  const press = (label: RegExp) => {
    const node = [...container.querySelectorAll<HTMLElement>("[aria-label]")].find((each) => label.test(each.getAttribute("aria-label") ?? ""));
    if (node === undefined) throw new Error(`no row ${label}`);
    act(() => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  return { did, press };
}

describe("a folder's row in the tree leaves the full pages", () => {
  test("with Agent Mail open, the bots folder closes it and shows the folder", () => {
    const tree = mount([row("folder", "bots")], true);
    tree.press(/^bots/);
    expect(tree.did).toEqual(["toggle bots", "select bots", "close mail"]);
  });

  test("with nothing full-page open, it only toggles and selects", () => {
    const tree = mount([row("folder", "bots")], false);
    tree.press(/^bots/);
    expect(tree.did).toEqual(["toggle bots", "select bots"]);
  });
});
