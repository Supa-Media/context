/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The account button at the foot of the sidebar, and the card it opens.
 *
 * Discord's shape, asked for by the owner on 2026-09-26 in place of the title
 * bar's workspace chip and the recent-workspace marks at the tree's foot. The
 * list behind it is unchanged — `routeReachability` and `meetingsEntry` hold
 * each row's destination — so this holds what is new: the button carries *you*,
 * the card says who you are before it lists anything, the workspace you are in
 * is the checked one, activity elsewhere shows with the card closed, and the
 * card stays inside the window.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SwitcherMenu } =
  require("../features/console/SwitcherMenu") as typeof import("../features/console/SwitcherMenu");
const { cardPlacement, CARD_MIN_WIDTH } =
  require("../features/console/AccountCard") as typeof import("../features/console/AccountCard");
type ConsoleData = import("../features/console/types").ConsoleData;
type ConsoleContext = import("../features/console/types").ConsoleContext;

function ctx(slug: string, over: Partial<ConsoleContext> = {}): ConsoleContext {
  return {
    id: `id-${slug}`,
    slug,
    displayName: slug,
    role: "member",
    kind: "shared",
    status: "ok",
    ...over,
  } as ConsoleContext;
}

function data(contexts: ConsoleContext[], selectedSlug: string | null): ConsoleData {
  return {
    loading: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts,
    selectedContextId: contexts.find((c) => c.slug === selectedSlug)?.id ?? null,
  } as unknown as ConsoleData;
}

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
  return { container, find, press };
}

const seyi = ctx("seyi", { kind: "personal", role: "owner" });
const supa = ctx("supa");
const worship = ctx("public-worship", { hasNewActivity: true });

describe("the account button", () => {
  test("carries you, and the workspace you are in under your name", () => {
    const ui = mount(
      createElement(SwitcherMenu, {
        data: data([seyi, supa], "supa"),
        label: "@supa",
        onOpenContext: () => {},
      }),
    );
    const button = ui.find("account-switcher")!;
    expect(button.textContent).toContain("@seyi");
    expect(button.textContent).toContain("@supa");
    expect(button.getAttribute("aria-label")).toBe("@seyi, in @supa: workspaces and account");
  });

  test("the card opens with who you are, then the workspaces, then the way out", () => {
    const signedOut: string[] = [];
    const ui = mount(
      createElement(SwitcherMenu, {
        data: data([seyi, supa], "supa"),
        label: "@supa",
        onOpenContext: () => {},
        onOpenSettings: () => {},
        onSignOut: () => signedOut.push("out"),
      }),
    );
    expect(ui.find("account-card")).toBeNull();
    ui.press("account-switcher");
    const card = ui.find("account-card")!;
    const text = card.textContent ?? "";
    expect(text.indexOf("seyi@context.lc")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("seyi@context.lc")).toBeLessThan(text.indexOf("@supa"));
    expect(text.indexOf("@supa")).toBeLessThan(text.indexOf("Settings"));
    expect(text.indexOf("Settings")).toBeLessThan(text.indexOf("Sign out"));

    ui.press("switcher-sign-out");
    expect(signedOut).toEqual(["out"]);
    expect(ui.find("account-card")).toBeNull();
  });

  test("the workspace you are in is the checked one, and yours is marked", () => {
    const ui = mount(
      createElement(SwitcherMenu, { data: data([seyi, supa], "supa"), label: "@supa", onOpenContext: () => {} }),
    );
    ui.press("account-switcher");
    expect(ui.find("switcher-context-supa")!.getAttribute("aria-checked")).toBe("true");
    expect(ui.find("switcher-context-seyi")!.getAttribute("aria-checked")).toBe("false");
    expect(ui.find("switcher-context-seyi")!.textContent).toContain("yours");
  });

  test("pressing a workspace switches to it and closes the card", () => {
    const opened: string[] = [];
    const ui = mount(
      createElement(SwitcherMenu, {
        data: data([seyi, supa], "seyi"),
        label: "@seyi",
        onOpenContext: (slug: string) => opened.push(slug),
      }),
    );
    ui.press("account-switcher");
    ui.press("switcher-context-supa");
    expect(opened).toEqual(["supa"]);
    expect(ui.find("account-card")).toBeNull();
  });

  test("activity in another workspace shows on the closed button", () => {
    const quiet = mount(
      createElement(SwitcherMenu, { data: data([seyi, supa], "seyi"), label: "@seyi", onOpenContext: () => {} }),
    );
    expect(quiet.find("account-switcher-activity")).toBeNull();
    live.pop()!();

    const busy = mount(
      createElement(SwitcherMenu, {
        data: data([seyi, supa, worship], "seyi"),
        label: "@seyi",
        onOpenContext: () => {},
      }),
    );
    expect(busy.find("account-switcher-activity")).not.toBeNull();
    live.pop()!();

    // Activity where you already are is not news.
    const here = mount(
      createElement(SwitcherMenu, {
        data: data([seyi, worship], "public-worship"),
        label: "@public-worship",
        onOpenContext: () => {},
      }),
    );
    expect(here.find("account-switcher-activity")).toBeNull();
  });
});

describe("cardPlacement: the card stays inside the window", () => {
  const view = { width: 1440, height: 900 };

  test("from the bottom left it rises, at least as wide as the button", () => {
    const box = cardPlacement({ x: 0, y: 840, width: 300, height: 52 }, view);
    expect(box).toEqual({ left: 8, width: 300, maxHeight: 826, bottom: 66 });
  });

  test("a narrow sidebar still gets a card wide enough to read", () => {
    const box = cardPlacement({ x: 12, y: 840, width: 180, height: 52 }, view);
    expect(box.width).toBe(CARD_MIN_WIDTH);
  });

  test("near the right edge it is pulled back in", () => {
    const box = cardPlacement({ x: 1400, y: 840, width: 0, height: 0 }, view);
    expect(box.left + box.width).toBeLessThanOrEqual(view.width - 8);
  });

  test("from the top of the window it opens downward", () => {
    const box = cardPlacement({ x: 0, y: 10, width: 260, height: 40 }, view);
    expect("top" in box && box.top).toBe(56);
  });
});
