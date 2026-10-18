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
 *  4. **The page is board A2**: a sidebar of people in the tree's column,
 *     real titles, short times, and a row opens the note in place (A3).
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   row given detail "Shared with me"                              2
 *   unseenCount treats a loading seenAt as never seen               1
 *   SwitcherMenu ignores shared.unseen for the avatar dot           1
 *   placeLabel names the sharer's personal workspace                2
 *   sharedNoteHref points at /s/<token>                             1
 *   itemTitle ignores the server's title                            2
 *   sidebar ignores seenAt for the dots                             1
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inbox = require("../features/console/shared/sharedInbox") as typeof import("../features/console/shared/sharedInbox");
const { SharedList } = require("../features/console/shared/SharedPane") as typeof import("../features/console/shared/SharedPane");
const { SharedSidebar } =
  require("../features/console/shared/SharedSidebar") as typeof import("../features/console/shared/SharedSidebar");
const { SwitcherMenu, sheetItems } =
  require("../features/console/SwitcherMenu") as typeof import("../features/console/SwitcherMenu");
type SharedItem = import("../features/console/shared/sharedInbox").ShareItem;
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
    sharedByName: null,
    title: null,
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
    expect(inbox.itemTitle({ ...chaos, title: "Beneath the Chaos" })).toBe("Beneath the Chaos");
    expect(inbox.sharerLabel(chaos)).toBe("@ana");
    expect(inbox.sharerLabel({ ...chaos, sharedByName: "Ana Ruiz" })).toBe("Ana Ruiz");
    expect(inbox.sharerLabel(item({ sharedByHandle: null }))).toBe("Someone");
    expect(inbox.placeLabel(chaos)).toBeNull();
    expect(inbox.placeLabel(plan)).toBe("Atlas");
    expect(inbox.placeLabel({ ...plan, displayName: " " })).toBe("@atlas");
  });

  test("opens inside @shared, and a link inside it follows the share's own page", () => {
    expect(inbox.sharedNoteHref("a b")).toBe("/console/shared?note=a%20b");
    expect(inbox.sharedLinkHref("abc")).toBe("/s/abc");
    expect(inbox.SHARED_HREF).toBe("/console/shared");
  });

  test("the time the way the board writes it", () => {
    expect(inbox.shortWhen(NOW - 30 * 1000, NOW)).toBe("Just now");
    expect(inbox.shortWhen(NOW - 5 * 60 * 1000, NOW)).toBe("5m ago");
    expect(inbox.shortWhen(NOW - 2 * HOUR, NOW)).toBe("2h ago");
    expect(inbox.shortWhen(NOW - 20 * HOUR, NOW)).toBe("Yesterday");
    expect(inbox.shortWhen(new Date(2026, 9, 9, 12).getTime(), NOW)).toBe("Oct 9");
    expect(inbox.shortWhen(new Date(2025, 9, 9, 12).getTime(), NOW)).toBe("Oct 9, 2025");
  });

  test("the filter matches a title, a sharer or a workspace", () => {
    expect(inbox.matchesFilter(plan, "atl")).toBe(true);
    expect(inbox.matchesFilter(plan, "BO")).toBe(true);
    expect(inbox.matchesFilter(plan, "chaos")).toBe(false);
    expect(inbox.matchesFilter(plan, "  ")).toBe(true);
  });
});

describe("the groups", () => {
  test("by day, newest first, empty groups left out", () => {
    const groups = inbox.groupByDay([old, plan, chaos], NOW);
    expect(groups.map((group) => group.heading)).toEqual(["Today", "This week", "Earlier"]);
    expect(groups.map((group) => group.items.map((i) => inbox.sharedItemKey(i)))).toEqual([["tok-chaos"], ["tok-plan"], ["tok-old"]]);
    expect(inbox.groupByDay([chaos], NOW).map((group) => group.heading)).toEqual(["Today"]);
  });

  test("by person, most recent sharer first, two handle-less people kept apart", () => {
    const people = inbox.groupByPerson([old, plan, chaos]);
    expect(people.map((group) => group.label)).toEqual(["@ana", "@bo"]);
    expect(people[0]!.items.map((i) => inbox.sharedItemKey(i))).toEqual(["tok-chaos", "tok-old"]);
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

function list(items: SharedItem[] | undefined, opened: string[] = [], seenAt: number | null | undefined = NOW - 24 * HOUR) {
  return mount(
    createElement(SharedList, {
      items,
      seenAt,
      now: NOW,
      phone: false,
      me: "@seyi",
      onOpen: (t: string) => opened.push(t),
      onBack: () => {},
    }),
  );
}

describe("the page (board A2)", () => {
  test("rows grouped by day, real titles, sharer, short time, and a dot on what is new", () => {
    const opened: string[] = [];
    const ui = list([old, plan, { ...chaos, title: "Beneath the Chaos", sharedByName: "Ana Ruiz" }], opened);
    const text = ui.find("shared-pane")!.textContent ?? "";
    expect(text).toContain("Shared with me");
    expect(text.indexOf("Today")).toBeLessThan(text.indexOf("This week"));
    expect(text.indexOf("This week")).toBeLessThan(text.indexOf("Earlier"));
    const chaosRow = ui.find("shared-row-tok-chaos")!.textContent ?? "";
    expect(chaosRow).toContain("Beneath the Chaos");
    expect(chaosRow).toContain("Ana Ruiz");
    expect(chaosRow).not.toContain("in Ana");
    expect(chaosRow).toContain("Can read");
    expect(chaosRow).toContain("2h ago");
    expect(ui.find("shared-new-tok-chaos")).not.toBeNull();
    expect(ui.find("shared-new-tok-plan")).toBeNull();
    expect(ui.find("shared-row-tok-plan")!.textContent).toContain("in Atlas");
    expect(ui.find("shared-close")).toBeNull();
    ui.press("shared-row-tok-plan");
    expect(opened).toEqual(["tok-plan"]);
  });

  test("Can edit is honestly empty: every share reads for now", () => {
    const ui = list([chaos]);
    ui.press("shared-filter-edit");
    expect(ui.find("shared-row-tok-chaos")).toBeNull();
    expect(ui.find("shared-none-editable")).not.toBeNull();
    ui.press("shared-filter-all");
    expect(ui.find("shared-row-tok-chaos")).not.toBeNull();
  });

  test("empty says who it is for and that membership is not needed; loading draws nothing", () => {
    const empty = list([]);
    const words = empty.find("shared-empty")!.textContent ?? "";
    expect(words).toContain("Nothing shared with you yet");
    expect(words).toContain("@seyi");
    expect(words).toContain("not in their workspace");
    live.pop()!();
    const loading = list(undefined);
    expect(loading.find("shared-empty")).toBeNull();
    expect(loading.find("shared-row-tok-chaos")).toBeNull();
  });
});

describe("the sidebar (board A2's left column)", () => {
  function sidebar(selected: string | null, events: string[] = []) {
    return mount(
      createElement(SharedSidebar, {
        items: [old, plan, chaos],
        selected,
        seenAt: NOW - 24 * HOUR,
        onEverything: () => events.push("everything"),
        onOpen: (t: string) => events.push(t),
        foot: null,
      }),
    );
  }

  test("Everything with its count, then people with their notes, new ones dotted", () => {
    const events: string[] = [];
    const ui = sidebar(null, events);
    expect(ui.find("shared-everything")!.textContent).toContain("3");
    expect(ui.find("shared-everything")!.querySelector('[data-testid="shared-here"]')).not.toBeNull();
    expect(ui.find("shared-person-user-ana")!.textContent).toContain("@ana");
    expect(ui.find("shared-side-tok-chaos")).not.toBeNull();
    expect(ui.find("shared-side-new-tok-chaos")).not.toBeNull();
    expect(ui.find("shared-side-new-tok-old")).toBeNull();
    ui.press("shared-side-tok-plan");
    ui.press("shared-everything");
    expect(events).toEqual(["tok-plan", "everything"]);
  });

  test("a person folds away their notes; the open note is the selected row", () => {
    const ui = sidebar("tok-chaos");
    expect(ui.find("shared-side-tok-chaos")!.querySelector('[data-testid="shared-here"]')).not.toBeNull();
    expect(ui.find("shared-everything")!.querySelector('[data-testid="shared-here"]')).toBeNull();
    ui.press("shared-person-user-ana");
    expect(ui.find("shared-side-tok-chaos")).toBeNull();
    expect(ui.find("shared-side-tok-plan")).not.toBeNull();
  });
});
