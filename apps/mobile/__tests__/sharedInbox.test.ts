/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * @SHARED — everything people shared with you by name, in the account menu.
 *
 * Dev2 picked board A on 2026-10-14: a row under your workspaces, labelled
 * `@shared` and nothing else ("not 'Shared with me' next to it as well"),
 * opening a list grouped by day with who shared each note. What is pinned:
 *
 *  1. **The row says `@shared` alone**, on the card and on the phone's sheet,
 *     and a dot only while something new has arrived.
 *  2. **The dot never shows while loading.**
 *  3. **The list groups by day, names the sharer, and names a workspace only
 *     when it is a shared one.**
 *  4. **A row opens the share's own page**, the real editor, read only.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   row given detail "Shared with me"                              2
 *   unseenCount treats a loading seenAt as never seen               1
 *   SwitcherMenu ignores shared.unseen for the avatar dot           1
 *   placeLabel names the sharer's personal workspace                2
 *   sharedOpenHref points at /console/@slug                         1
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inbox = require("../features/console/shared/sharedInbox") as typeof import("../features/console/shared/sharedInbox");
const { SharedList } = require("../features/console/shared/SharedPane") as typeof import("../features/console/shared/SharedPane");
const { SwitcherMenu, sheetItems } =
  require("../features/console/SwitcherMenu") as typeof import("../features/console/SwitcherMenu");
type SharedItem = import("../features/console/shared/sharedInbox").SharedItem;
type ConsoleData = import("../features/console/types").ConsoleData;
type ConsoleContext = import("../features/console/types").ConsoleContext;

const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

function item(over: Partial<SharedItem> = {}): SharedItem {
  return {
    token: "tok-chaos",
    workspaceId: "ws-ana",
    slug: "ana",
    displayName: "Ana",
    workspaceKind: "personal",
    entryPath: "1-projects/beneath-the-chaos.md",
    sharedBy: "user-ana",
    sharedByHandle: "ana",
    createdAt: NOW - 2 * HOUR,
    ...over,
  };
}

const chaos = item();
const plan = item({
  token: "tok-plan",
  workspaceId: "ws-atlas",
  slug: "atlas",
  displayName: "Atlas",
  workspaceKind: "shared",
  entryPath: "1-projects/plan.md",
  sharedBy: "user-bo",
  sharedByHandle: "bo",
  createdAt: NOW - 3 * 24 * HOUR,
});
const old = item({ token: "tok-old", entryPath: "3-resources/recipes.md", createdAt: NOW - 30 * 24 * HOUR });

describe("what a row says", () => {
  test("the note's name, who shared it, and a workspace only when it is a shared one", () => {
    expect(inbox.itemTitle(chaos)).toBe("beneath-the-chaos");
    expect(inbox.sharerLabel(chaos)).toBe("@ana");
    expect(inbox.sharerLabel(item({ sharedByHandle: null }))).toBe("Someone");
    expect(inbox.placeLabel(chaos)).toBeNull();
    expect(inbox.placeLabel(plan)).toBe("Atlas");
    expect(inbox.placeLabel({ ...plan, displayName: " " })).toBe("@atlas");
  });

  test("opens the share's own page, never a members-only console address", () => {
    expect(inbox.sharedOpenHref("abc")).toBe("/s/abc");
    expect(inbox.SHARED_HREF).toBe("/console/shared");
  });
});

describe("the groups", () => {
  test("by day, newest first, empty groups left out", () => {
    const groups = inbox.groupByDay([old, plan, chaos], NOW);
    expect(groups.map((group) => group.heading)).toEqual(["Today", "This week", "Earlier"]);
    expect(groups.map((group) => group.items.map((i) => i.token))).toEqual([["tok-chaos"], ["tok-plan"], ["tok-old"]]);
    expect(inbox.groupByDay([chaos], NOW).map((group) => group.heading)).toEqual(["Today"]);
  });

  test("by person, most recent sharer first, two handle-less people kept apart", () => {
    const people = inbox.groupByPerson([old, plan, chaos]);
    expect(people.map((group) => group.label)).toEqual(["@ana", "@bo"]);
    expect(people[0]!.items.map((i) => i.token)).toEqual(["tok-chaos", "tok-old"]);
    const nameless = inbox.groupByPerson([
      item({ sharedBy: "u1", sharedByHandle: null }),
      item({ token: "t2", sharedBy: "u2", sharedByHandle: null }),
    ]);
    expect(nameless).toHaveLength(2);
  });
});

describe("the dot", () => {
  test("counts what arrived since you last looked, and nothing while loading", () => {
    expect(inbox.unseenCount([chaos, plan], null)).toBe(2);
    expect(inbox.unseenCount([chaos, plan], NOW - 24 * HOUR)).toBe(1);
    expect(inbox.unseenCount([chaos, plan], NOW)).toBe(0);
    expect(inbox.unseenCount(undefined, null)).toBe(0);
    expect(inbox.unseenCount([chaos], undefined)).toBe(0);
  });
});

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

function ctx(slug: string, over: Partial<ConsoleContext> = {}): ConsoleContext {
  return { id: `id-${slug}`, slug, displayName: slug, role: "member", kind: "shared", status: "ok", ...over } as ConsoleContext;
}
const consoleData = {
  loading: false,
  viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
  contexts: [ctx("seyi", { kind: "personal", role: "owner" })],
  selectedContextId: "id-seyi",
} as unknown as ConsoleData;

function menu(shared?: { unseen: number; onOpen: () => void }) {
  return mount(
    createElement(SwitcherMenu, { data: consoleData, label: "@seyi", onOpenContext: () => {}, shared }),
  );
}

describe("the account menu row", () => {
  test("says @shared and nothing else; something new dots it and the closed button", () => {
    const opened: string[] = [];
    const ui = menu({ unseen: 2, onOpen: () => opened.push("open") });
    expect(ui.find("account-switcher-activity")).not.toBeNull();
    expect(ui.find("account-switcher")!.getAttribute("aria-label")).toContain("something new in @shared");
    ui.press("account-switcher");
    expect(ui.find("switcher-shared")!.textContent).toBe("@shared");
    expect(ui.find("switcher-shared-dot")).not.toBeNull();
    ui.press("switcher-shared");
    expect(opened).toEqual(["open"]);
    expect(ui.find("account-card")).toBeNull();
  });

  test("nothing new: the row stays, no dots; no prop, no row", () => {
    const seen = menu({ unseen: 0, onOpen: () => {} });
    expect(seen.find("account-switcher-activity")).toBeNull();
    seen.press("account-switcher");
    expect(seen.find("switcher-shared")!.textContent).toBe("@shared");
    expect(seen.find("switcher-shared-dot")).toBeNull();
    live.pop()!();

    const none = menu(undefined);
    none.press("account-switcher");
    expect(none.find("switcher-shared")).toBeNull();
  });

  test("on the phone's sheet it is @shared too, with no detail unless something is new", () => {
    const row = (unseen: number) =>
      sheetItems([
        {
          key: "workspaces",
          rows: [{ id: "shared", label: "@shared", badge: unseen > 0, testID: "switcher-shared" }],
        },
      ])[0]!;
    expect(row(0).label).toBe("@shared");
    expect(row(0).detail).toBeUndefined();
    expect(row(1).detail).toBe("new");
  });
});

describe("the page", () => {
  test("rows grouped by day, each naming its sharer and opening its share", () => {
    const opened: string[] = [];
    const ui = mount(
      createElement(SharedList, { items: [old, plan, chaos], onOpen: (t: string) => opened.push(t), onClose: () => {}, now: NOW }),
    );
    const text = ui.find("shared-list")!.textContent ?? "";
    expect(text.indexOf("Today")).toBeLessThan(text.indexOf("This week"));
    expect(text.indexOf("This week")).toBeLessThan(text.indexOf("Earlier"));
    const chaosRow = ui.find("shared-row-tok-chaos")!.textContent ?? "";
    expect(chaosRow).toContain("beneath-the-chaos");
    expect(chaosRow).toContain("@ana");
    expect(chaosRow).not.toContain("in Ana");
    expect(chaosRow).toContain("Can read");
    expect(ui.find("shared-row-tok-plan")!.textContent).toContain("in Atlas");
    ui.press("shared-row-tok-plan");
    expect(opened).toEqual(["tok-plan"]);
  });

  test("empty says what arrives here; loading draws no list at all", () => {
    const empty = mount(createElement(SharedList, { items: [], onOpen: () => {}, onClose: () => {}, now: NOW }));
    expect(empty.find("shared-empty")!.textContent).toContain("Nothing shared with you yet.");
    live.pop()!();
    const loading = mount(createElement(SharedList, { items: undefined, onOpen: () => {}, onClose: () => {}, now: NOW }));
    expect(loading.find("shared-empty")).toBeNull();
    expect(loading.find("shared-list")).toBeNull();
  });
});
