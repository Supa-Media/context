/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * WHAT'S NEW — the newest devlog week, in the account menu.
 *
 * Approved by the owner on 2026-09-29 (the weekly updates artboard): a row in
 * the account card under Settings, a dot on it and on the avatar while the
 * week is unread, and a panel that says what the page says, in its four
 * sections. What is pinned here:
 *
 *  1. **Only a four-section week makes a row.** The old single-list weeks do
 *     not, so the row appears with the first real week, not before.
 *  2. **The dot is a week you have not opened**, never shown while loading.
 *  3. **Shipped shows five and a count**, like the Discord post.
 *  4. **Exploring always carries "ideas, not promises".**
 *  5. **An offline person sees their last copy, and is told it is one.**
 *  6. **Discord is the admin console's link or nothing**: no link, no button.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   weekFromPages keeps unsectioned weeks                          1
 *   isUnread treats a still-loading read marker as never read      1
 *   SHIPPED_SHOWN = 50                                             1
 *   panel drops the exploring disclaimer                           1
 *   SwitcherMenu ignores whatsNew.unread for the avatar dot        1
 *   panel always draws the Discord button                          1
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { parseDevlog } = require("@context/shared") as typeof import("@context/shared");
const whatsNew = require("../features/console/whatsNew/whatsNew") as typeof import("../features/console/whatsNew/whatsNew");
const { WhatsNewPanel } =
  require("../features/console/whatsNew/WhatsNewPanel") as typeof import("../features/console/whatsNew/WhatsNewPanel");
const { SwitcherMenu } =
  require("../features/console/SwitcherMenu") as typeof import("../features/console/SwitcherMenu");
type ConsoleData = import("../features/console/types").ConsoleData;
type ConsoleContext = import("../features/console/types").ConsoleContext;
type WhatsNewState = import("../features/console/whatsNew/whatsNew").WhatsNewState;

const DEVLOG = `# devlog

### week 5
*september 21 to 27, 2026*

#### shipped
- comments on notes.
- projects: tasks and a board.
- one $5 plan.
- faces instead of initials.
- a free tier of 1,000 notes.
- faster deploys.
- invite-only sign-in.

#### in progress
- the iOS app on the App Store.

#### exploring
*ideas, not promises. some of these won't happen.*
- looking at: a graph view of how your notes link.

#### declined

### week 4
*september 14-20, 2026*

- sandbox for plugins
`;

const pages = (markdown: string) => [
  { path: "index.md", routePath: "/index", markdown: "# home" },
  { path: "devlog.md", routePath: "/devlog", markdown },
];

const five = parseDevlog(DEVLOG)[0]!;

describe("the week What's new shows", () => {
  test("is the newest four-section week on the devlog page", () => {
    expect(whatsNew.weekFromPages(pages(DEVLOG))?.number).toBe(5);
  });

  test("a page of old single-list weeks has none, so there is no row", () => {
    expect(whatsNew.weekFromPages(pages("### week 4\n- sandbox for plugins\n"))).toBeNull();
    expect(whatsNew.weekFromPages([{ path: "index.md", routePath: "/index", markdown: DEVLOG }])).toBeNull();
    expect(whatsNew.weekFromPages(null)).toBeNull();
  });
});

describe("the dot", () => {
  const ready: WhatsNewState = { kind: "ready", week: five };
  test("is a week this person has not opened", () => {
    expect(whatsNew.isUnread(ready, null)).toBe(true);
    expect(whatsNew.isUnread(ready, 4)).toBe(true);
    expect(whatsNew.isUnread(ready, 5)).toBe(false);
    expect(whatsNew.isUnread(ready, 6)).toBe(false);
  });

  test("never shows while either side is still loading", () => {
    expect(whatsNew.isUnread(ready, undefined)).toBe(false);
    expect(whatsNew.isUnread({ kind: "loading" }, null)).toBe(false);
    expect(whatsNew.isUnread({ kind: "error" }, null)).toBe(false);
  });
});

describe("the offline copy", () => {
  test("round-trips, and a broken or absent store costs only the copy", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    whatsNew.writeCachedWeek(storage, five, 1_000);
    expect(whatsNew.readCachedWeek(storage)).toEqual({ week: five, savedAt: 1_000 });
    store.set([...store.keys()][0]!, "{not json");
    expect(whatsNew.readCachedWeek(storage)).toBeNull();
    expect(whatsNew.readCachedWeek(null)).toBeNull();
    const full = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => whatsNew.writeCachedWeek(full, five, 1)).not.toThrow();
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

function panel(state: WhatsNewState, onRetry: () => void = () => {}, discordUrl: string | null = null) {
  return mount(createElement(WhatsNewPanel, { state, onClose: () => {}, onRetry, discordUrl }));
}

describe("the panel", () => {
  test("shows the four sections in the page's words, five shipped lines and a count", () => {
    const ui = panel({ kind: "ready", week: five });
    expect(ui.find("whats-new-panel")!.textContent).toContain("week 5 · september 21 to 27, 2026");
    const shipped = ui.find("whats-new-shipped")!.textContent ?? "";
    expect(shipped).toContain("a free tier of 1,000 notes.");
    expect(shipped).not.toContain("faster deploys.");
    expect(ui.find("whats-new-more")!.textContent).toBe("2 more");
    ui.press("whats-new-more");
    expect(ui.find("whats-new-shipped")!.textContent).toContain("invite-only sign-in.");
    expect(ui.find("whats-new-more")).toBeNull();
  });

  test("exploring carries its line; an empty section says so", () => {
    const ui = panel({ kind: "ready", week: five });
    expect(ui.find("whats-new-exploring")!.textContent).toContain("ideas, not promises. some of these won't happen.");
    expect(ui.find("whats-new-declined")!.textContent).toContain("nothing this week");
  });

  test("Discuss on Discord shows only when the admin console has a link", () => {
    expect(panel({ kind: "ready", week: five }).find("whats-new-discord")).toBeNull();
    live.pop()!();
    const linked = panel({ kind: "ready", week: five }, () => {}, "https://example.invalid/invite");
    expect(linked.find("whats-new-discord")!.textContent).toBe("Discuss on Discord");
  });

  test("loading, error with a way to try again, and the offline copy named as one", () => {
    expect(panel({ kind: "loading" }).find("whats-new-loading")).not.toBeNull();
    live.pop()!();

    const retried: string[] = [];
    const failed = panel({ kind: "error" }, () => retried.push("again"));
    expect(failed.find("whats-new-error")!.textContent).toContain("Couldn't load what's new");
    failed.press("whats-new-retry");
    expect(retried).toEqual(["again"]);
    live.pop()!();

    const offline = panel({ kind: "offline", week: five, savedAt: new Date(2026, 8, 27).getTime() });
    expect(offline.find("whats-new-offline")!.textContent).toContain("saved on sept 27");
    expect(offline.find("whats-new-shipped")).not.toBeNull();
  });
});

function ctx(slug: string, over: Partial<ConsoleContext> = {}): ConsoleContext {
  return { id: `id-${slug}`, slug, displayName: slug, role: "member", kind: "shared", status: "ok", ...over } as ConsoleContext;
}
const consoleData = {
  loading: false,
  viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
  contexts: [ctx("seyi", { kind: "personal", role: "owner" })],
  selectedContextId: "id-seyi",
} as unknown as ConsoleData;

describe("the account menu row", () => {
  test("an unread week dots the row and the closed button; opening it asks for the panel", () => {
    const opened: string[] = [];
    const ui = mount(
      createElement(SwitcherMenu, {
        data: consoleData,
        label: "@seyi",
        onOpenContext: () => {},
        onOpenSettings: () => {},
        whatsNew: { week: 5, unread: true, onOpen: () => opened.push("open") },
      }),
    );
    expect(ui.find("account-switcher-activity")).not.toBeNull();
    expect(ui.find("account-switcher")!.getAttribute("aria-label")).toContain("what's new is unread");
    ui.press("account-switcher");
    const row = ui.find("switcher-whats-new")!;
    expect(row.textContent).toContain("What's new");
    expect(row.textContent).toContain("week 5");
    expect(ui.find("switcher-whats-new-dot")).not.toBeNull();
    ui.press("switcher-whats-new");
    expect(opened).toEqual(["open"]);
    expect(ui.find("account-card")).toBeNull();
  });

  test("a read week keeps the row and loses both dots; no week, no row", () => {
    const read = mount(
      createElement(SwitcherMenu, {
        data: consoleData,
        label: "@seyi",
        onOpenContext: () => {},
        whatsNew: { week: 5, unread: false, onOpen: () => {} },
      }),
    );
    expect(read.find("account-switcher-activity")).toBeNull();
    read.press("account-switcher");
    expect(read.find("switcher-whats-new")).not.toBeNull();
    expect(read.find("switcher-whats-new-dot")).toBeNull();
    live.pop()!();

    const none = mount(createElement(SwitcherMenu, { data: consoleData, label: "@seyi", onOpenContext: () => {} }));
    none.press("account-switcher");
    expect(none.find("switcher-whats-new")).toBeNull();
  });
});
