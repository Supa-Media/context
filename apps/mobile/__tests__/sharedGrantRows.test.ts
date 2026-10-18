/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * A grant is a row of Shared with me like a share. These mount the real list and
 * sidebar with grant items beside share items, and pin what a grant row does:
 *
 *  1. **It is listed and opened under its grant key**, and a share under its token,
 *     so a press on a grant names the grant and nothing else.
 *  2. **It carries a report control too**, named by its note id (2026-10-17). It
 *     offers to block only when the grant records who wrote it.
 *  3. **A granted folder reads as a folder, and an unrecorded granter is "Someone".**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   row opens by token for a grant (undefined)                    1
 *   a grant row gets no report control                            1
 *   the sidebar selects a grant by its token                      1
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SharedList } = require("../features/console/shared/SharedPane") as typeof import("../features/console/shared/SharedPane");
const { SharedSidebar } =
  require("../features/console/shared/SharedSidebar") as typeof import("../features/console/shared/SharedSidebar");
type SharedItem = import("../features/console/shared/sharedInbox").SharedItem;

const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;
const WS = "wsacme0001";
const NOTE = "0190f2c0-7a1b-7000-8000-00000000abcd";
const FOLDER = "0190f2c0-7a1b-7000-8000-00000000f0f0";

const share: SharedItem = {
  token: "tok-chaos",
  workspaceId: "ws-ana",
  slug: "ana",
  displayName: "Ana",
  workspaceKind: "personal",
  entryPath: "1-projects/beneath-the-chaos.md",
  sharedBy: "user-ana",
  sharedByHandle: "ana",
  sharedByName: "Ana Ruiz",
  title: "Beneath the Chaos",
  createdAt: NOW - 2 * HOUR,
};

const plan: SharedItem = {
  kind: "grant",
  workspaceId: WS,
  slug: "acme",
  displayName: "Acme Editorial Collective for the Long Tail of Shared Work",
  workspaceKind: "shared",
  noteId: NOTE,
  entryPath: "1-projects/a-long-plan-title-that-runs-well-past-seventy-characters-in-a-row.md",
  itemKind: "file",
  sharedBy: null,
  sharedByHandle: null,
  sharedByName: null,
  title: "A long plan title that runs well past seventy characters in a row for the list",
  createdAt: NOW - 3 * HOUR,
};

const folder: SharedItem = {
  kind: "grant",
  workspaceId: WS,
  slug: "acme",
  displayName: "Acme",
  workspaceKind: "shared",
  noteId: FOLDER,
  entryPath: "3-resources",
  itemKind: "folder",
  sharedBy: "user-ana",
  sharedByHandle: "ana",
  sharedByName: null,
  title: "3-resources",
  createdAt: NOW - 5 * HOUR,
};

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
});

function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(element));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const press = (id: string) => {
    const node = find(id);
    if (node === null) throw new Error(`nothing to press: ${id}`);
    act(() => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  return { find, press };
}

const GRANT_KEY = `grant:${WS}.${NOTE}`;
const FOLDER_KEY = `grant:${WS}.${FOLDER}`;

describe("grant rows in the list", () => {
  test("a grant is listed and opened under its grant key, a share under its token", () => {
    const opened: string[] = [];
    const ui = mount(
      createElement(SharedList, {
        items: [share, plan, folder],
        seenAt: NOW - 24 * HOUR,
        now: NOW,
        phone: false,
        me: "@seyi",
        onOpen: (key: string) => opened.push(key),
        onBack: () => {},
      }),
    );
    expect(ui.find(`shared-row-${GRANT_KEY}`)).not.toBeNull();
    ui.press(`shared-row-${GRANT_KEY}`);
    ui.press("shared-row-tok-chaos");
    expect(opened).toEqual([GRANT_KEY, "tok-chaos"]);
  });

  test("a grant row names its workspace, and says the note is read-only", () => {
    const ui = mount(
      createElement(SharedList, {
        items: [plan],
        seenAt: NOW - 24 * HOUR,
        now: NOW,
        phone: false,
        me: "@seyi",
        onOpen: () => {},
        onBack: () => {},
      }),
    );
    const row = ui.find(`shared-row-${GRANT_KEY}`)!.textContent ?? "";
    expect(row).toContain("in Acme Editorial Collective for the Long Tail of Shared Work");
    expect(row).toContain("Can read");
    expect(row).toContain("A long plan title that runs well past seventy characters");
  });

  test("a grant row has a report control; with no recorded granter it reports without offering a block", () => {
    const ui = mount(
      createElement(SharedList, {
        items: [share, plan],
        seenAt: NOW - 24 * HOUR,
        now: NOW,
        phone: false,
        me: "@seyi",
        onOpen: () => {},
        onBack: () => {},
      }),
    );
    expect(ui.find("shared-report-tok-chaos")?.textContent).toBe("Report or block");
    expect(ui.find(`shared-report-${GRANT_KEY}`)?.textContent).toBe("Report");
  });

  test("a grant with no recorded granter shows Someone, and a granted folder opens as a row too", () => {
    const opened: string[] = [];
    const ui = mount(
      createElement(SharedList, {
        items: [plan, folder],
        seenAt: NOW - 24 * HOUR,
        now: NOW,
        phone: false,
        me: "@seyi",
        onOpen: (key: string) => opened.push(key),
        onBack: () => {},
      }),
    );
    expect(ui.find(`shared-row-${GRANT_KEY}`)!.textContent).toContain("Someone");
    ui.press(`shared-row-${FOLDER_KEY}`);
    expect(opened).toEqual([FOLDER_KEY]);
  });
});

describe("grant rows in the sidebar", () => {
  test("the open grant is the selected row, found by its key", () => {
    const ui = mount(
      createElement(SharedSidebar, {
        items: [share, plan],
        selected: GRANT_KEY,
        seenAt: NOW - 24 * HOUR,
        onEverything: () => {},
        onOpen: () => {},
        foot: null,
      }),
    );
    expect(ui.find(`shared-side-${GRANT_KEY}`)!.querySelector('[data-testid="shared-here"]')).not.toBeNull();
    expect(ui.find("shared-side-tok-chaos")!.querySelector('[data-testid="shared-here"]')).toBeNull();
  });

  test("a press on a grant in the sidebar opens it by its key", () => {
    const opened: string[] = [];
    const ui = mount(
      createElement(SharedSidebar, {
        items: [share, plan],
        selected: null,
        seenAt: NOW - 24 * HOUR,
        onEverything: () => {},
        onOpen: (key: string) => opened.push(key),
        foot: null,
      }),
    );
    ui.press(`shared-side-${GRANT_KEY}`);
    expect(opened).toEqual([GRANT_KEY]);
  });
});
