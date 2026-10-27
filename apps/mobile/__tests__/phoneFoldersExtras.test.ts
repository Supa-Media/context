/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * **What board 2 left off the phone's Folders page is still reachable.**
 *
 * Dev2 asked for Folders "EXACTLY like the mockups" (2026-10-17, board 2 of
 * `meeting-2026-10-17/phone-inbox/`): the title, `@name · N notes`, one Add a
 * folder button, Pinned and All folders. Trash and the Chaos line were the
 * page's last two rows, and nothing else on a phone opens either, so they
 * moved into the @name menu on Inbox. Notes outside every folder stay on the
 * page as the last rows of All folders, since no other page lists them.
 *
 * SABOTAGE: dropping the `trash` row from `SwitcherMenu`'s places fails the
 * first test; dropping the root notes from PhoneHome's card fails the last.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SwitcherMenu } =
  require("../features/console/SwitcherMenu") as typeof import("../features/console/SwitcherMenu");
const { TrashRouteProvider } =
  require("../features/console/trash/TrashRouteContext") as typeof import("../features/console/trash/TrashRouteContext");
const { ChaosProvider } = require("../features/chaos/ChaosContext") as typeof import("../features/chaos/ChaosContext");
const { PhoneHome } = require("../features/console/home/PhoneHome") as typeof import("../features/console/home/PhoneHome");
type ConsoleData = import("../features/console/types").ConsoleData;

const DATA = {
  loading: false,
  viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
  contexts: [{ id: "w1", slug: "seyi", displayName: "seyi", role: "owner", kind: "personal", status: "ok" }],
  selectedContextId: "w1",
} as unknown as ConsoleData;

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

function inboxMenu(phoneNamed: boolean, opened: string[]) {
  const trash = { open: false, openTrash: () => opened.push("trash"), closeTrash: () => {} };
  const chaos = {
    result: { kind: "chaosScore", available: true, score: 34, word: "crowded", weekAgo: null, folders: [], longNotes: [], folder: null },
    version: 1,
    folderScore: async () => null,
    refresh: () => {},
    panel: null,
    openPanel: () => opened.push("chaos"),
    closePanel: () => {},
  };
  return mount(
    createElement(
      ChaosProvider,
      { value: chaos as never },
      createElement(
        TrashRouteProvider,
        { value: trash as never },
        createElement(SwitcherMenu, {
          data: DATA,
          label: "@seyi",
          onOpenContext: () => {},
          trigger: "phone",
          phoneNamed,
        }),
      ),
    ),
  );
}

describe("the @name menu on Inbox", () => {
  test("has Trash, and it opens the Trash page", () => {
    const opened: string[] = [];
    const ui = inboxMenu(true, opened);
    ui.press("account-menu");
    ui.press("switcher-trash");
    expect(opened).toEqual(["trash"]);
  });

  test("has the Chaos line, which opens the panel", () => {
    const opened: string[] = [];
    const ui = inboxMenu(true, opened);
    ui.press("account-menu");
    expect(ui.find("switcher-chaos")?.textContent).toContain("Chaos 34 · crowded");
    ui.press("switcher-chaos");
    expect(opened).toEqual(["chaos"]);
  });

  test("and neither row is in the menu anywhere else", () => {
    const ui = inboxMenu(false, []);
    ui.press("account-menu");
    expect(ui.find("switcher-trash")).toBeNull();
    expect(ui.find("switcher-chaos")).toBeNull();
  });
});

describe("the Folders page, as board 2 draws it", () => {
  const source = {
    notes: [
      { path: "index.md", title: "Front page" },
      { path: "inbox/loose.md", title: "Loose" },
      { path: "2-areas/garden.md", title: "Garden" },
    ],
    folders: ["inbox", "2-areas"],
    shared: new Set<string>(),
  };
  const page = () =>
    mount(
      createElement(PhoneHome, {
        title: "seyi",
        handle: "@seyi",
        source,
        pins: [],
        opened: [],
        recents: [],
        onOpen: () => {},
        onAddFolder: () => {},
      } as never),
    );

  test("names the workspace as @name, lists no Inbox, and has no Trash, Chaos or storage rows", () => {
    const ui = page();
    expect(ui.find("phone-home-totals")?.textContent).toMatch(/^@seyi · /);
    const text = ui.find("phone-home")?.textContent ?? "";
    expect(text).toContain("areas");
    expect(text).not.toContain("inbox");
    expect(ui.find("phone-home-trash")).toBeNull();
    expect(ui.find("phone-home-chaos")).toBeNull();
    expect(ui.find("context-foot")).toBeNull();
    expect(ui.find("phone-home-add-folder")).toBeNull();
  });

  test("keeps notes outside every folder, as the last rows of All folders", () => {
    const ui = page();
    const text = ui.find("phone-home")?.textContent ?? "";
    expect(text).toContain("Front page");
    expect(text.indexOf("areas")).toBeLessThan(text.indexOf("Front page"));
  });
});
