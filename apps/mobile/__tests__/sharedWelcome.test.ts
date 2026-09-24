/**
 * @jest-environment jsdom
 */

/**
 * B2-02 — the welcome somebody gets the first time they open a workspace they
 * were invited into.
 *
 * It is `contextIntro`'s band drawn larger, not a second band, so the cases
 * that matter are: it is drawn where the intro is and nowhere else, it keeps
 * the intro's sentence (the filtered-view fact is the band's whole reason),
 * its rows go where they say, and answering it is the intro's answer.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useConvex: () => undefined,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { BrowsePane } from "../features/console/panes/BrowsePane";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { sharedWelcome } from "../features/console/sharedWelcome";
import type { ConsoleData } from "../features/console/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});
beforeEach(() => {
  window.localStorage.clear();
  setWidth(1400);
});

/** The demo's contexts: one this person owns, one they are a `member` of. */
const OWNED = "seyi";
const MEMBER_OF = "lk";

function setWidth(width: number): void {
  // jsdom lays nothing out and reports 0, which is `compact` — see
  // `contextIntroNotice.test.ts` for the trap this avoids.
  for (const [target, key, value] of [
    [document.documentElement, "clientWidth", width],
    [document.documentElement, "clientHeight", 800],
    [window, "innerWidth", width],
    [window, "innerHeight", 800],
  ] as const) {
    Object.defineProperty(target, key, { value, configurable: true });
  }
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

function demoData(contextId: string): ConsoleData {
  let latest: ConsoleData | null = null;
  function Probe() {
    latest = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  act(() => {
    latest!.selectContext(contextId);
  });
  return { ...latest!, demo: false } as ConsoleData;
}

async function browse(data: ConsoleData, onNavigate?: (href: string) => void) {
  const host = mount(() => createElement(BrowsePane, { data, onNavigate }));
  await act(async () => {});
  return host;
}

const q = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function press(node: HTMLElement | null): void {
  expect(node).not.toBeNull();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

describe("when the intro is drawn as the welcome", () => {
  const base = {
    intro: { kind: "member" },
    current: { slug: "dc-chapter", role: "member" },
    contexts: [{ kind: "shared", role: "member" }],
    demo: false,
    compact: false,
  };

  test("a member at a pointer width is welcomed, by handle and role", () => {
    expect(sharedWelcome(base)).toEqual({
      handle: "@dc-chapter",
      roleLabel: "Member",
      offerPersonal: true,
    });
  });

  test("nothing to say is nothing to welcome to", () => {
    expect(sharedWelcome({ ...base, intro: null })).toBeNull();
  });

  test("an owner is never welcomed to their own workspace", () => {
    const readOnlyOwner = { ...base, intro: { kind: "owner+read-only" } };
    expect(sharedWelcome({ ...readOnlyOwner, current: { slug: "mine", role: "owner" } })).toBeNull();
  });

  test("never the pinned context, the demo, or a phone", () => {
    expect(sharedWelcome({ ...base, intro: { kind: "pinned" } })).toBeNull();
    expect(sharedWelcome({ ...base, demo: true })).toBeNull();
    // The phone keeps its one line with no control — the band cannot be
    // answered where no chip repeats its fact.
    expect(sharedWelcome({ ...base, compact: true })).toBeNull();
  });

  test("a personal workspace is offered only to somebody without one", () => {
    const owns = { ...base, contexts: [...base.contexts, { kind: "personal", role: "owner" }] };
    expect(sharedWelcome(owns)?.offerPersonal).toBe(false);
    // Somebody else's personal workspace you are a member of is not yours.
    const visits = { ...base, contexts: [{ kind: "personal", role: "member" }] };
    expect(sharedWelcome(visits)?.offerPersonal).toBe(true);
  });
});

describe("the welcome, on screen", () => {
  test("keeps the intro's sentence, and its rows go where they say", async () => {
    const went: string[] = [];
    const host = await browse(demoData(MEMBER_OF), (href) => went.push(href));
    const card = q(host, "browse-context-intro");
    expect(card?.textContent).toContain("Welcome to @");
    expect(card?.textContent).toContain("You're in");
    // The fact the band exists for — this view is filtered — is still said.
    expect(card?.textContent).toContain("Team access");
    expect(q(host, "shared-welcome-role")?.textContent).toBe("Member");

    press(q(host, "shared-welcome-connect"));
    expect(went).toEqual(["/console/connections"]);
    // The demo person owns a personal workspace, so nothing offers another.
    expect(q(host, "shared-welcome-personal")).toBeNull();
  });

  test("answering it is the intro's answer", async () => {
    const host = await browse(demoData(MEMBER_OF), () => {});
    press(q(host, "browse-context-intro-dismiss"));
    expect(q(host, "browse-context-intro")).toBeNull();
    while (roots.length > 0) roots.pop()!();
    expect(q(await browse(demoData(MEMBER_OF), () => {}), "browse-context-intro")).toBeNull();
  });

  test("without a router the rows are text, not dead links", async () => {
    const host = await browse(demoData(MEMBER_OF));
    expect(q(host, "browse-context-intro")?.textContent).toContain("Connect a tool");
    expect(q(host, "shared-welcome-connect")).toBeNull();
  });

  test("your own workspace is never a welcome, even when it has a band", async () => {
    // The demo's own workspace cannot be written to, so it *does* have an
    // intro — the read-only sentence — which is the shape a cancelled,
    // read-only workspace has for its owner too.
    const host = await browse(demoData(OWNED), () => {});
    expect(q(host, "browse-context-intro")?.textContent).not.toContain("Welcome to");
    expect(q(host, "shared-welcome-role")).toBeNull();
  });
});
