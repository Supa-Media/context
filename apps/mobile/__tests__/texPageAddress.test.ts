/**
 * @jest-environment jsdom
 */

/**
 * The Tex page at the addresses Tex texts (the owner, 2026-11-03: "it should
 * show the hubs context.lc/tex/@user or context.lc/tex/group/<words> ... and
 * maybe link to sub pages"): a group's words open that group's page, found
 * among the person's own chats; words that name none of theirs show nothing
 * of any chat; a sub-page is a path; and moving around the page writes the
 * same addresses back.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-03):
 *  1. `chatOfWords` matching any chat's name instead of its home's words →
 *     "words that name no chat of theirs show nothing of any chat" fails.
 *  2. `go` pushing the old `?chat=` query → "moving around a group's page
 *     keeps the group's address" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";

const mockParams: { current: Record<string, string | string[]> } = { current: {} };
const mockPushed: unknown[] = [];
const mockRedirected: string[] = [];
/** Where Tex's own stack is (`index` 0: the first Tex screen), and whether anything is behind it. */
const mockNav = { index: 0, canGoBack: true, backs: 0, replaced: [] as string[] };

jest.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => {
    mockRedirected.push(href);
    return null;
  },
  Stack: () => null,
  router: {
    push: (href: unknown) => mockPushed.push(href),
    canGoBack: () => mockNav.canGoBack,
    back: () => (mockNav.backs += 1),
    replace: (href: string) => mockNav.replaced.push(href),
  },
  useLocalSearchParams: () => mockParams.current,
  useNavigation: () => ({ getState: () => ({ index: mockNav.index }) }),
}));
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: mockAuth.signedIn }),
  useAction: () => async () => null,
  useQuery: () => (mockAuth.signedIn ? [{ workspaceId: "ws_seyi", slug: "seyi", kind: "personal", role: "owner" }] : undefined),
}));
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "t" }) }));
jest.mock("../features/tex/useTexComputer", () => ({ useTexComputer: () => ({ phase: "idle" }) }));
jest.mock("../features/tex/page/texPageSource", () => ({ gatewaySource: () => mockHomedSource() }));

const mockAuth = { signedIn: true };

import { fixtureSource } from "../features/tex/page/texPageFixture";
import type { TexPageSource } from "../features/tex/page/texPageSource";
import { TexPageScreen } from "../features/tex/page/TexPageScreen";

const asked: string[] = [];
/** The mock's chats, the team's with a home, as the gateway's picker names it (`pickerOf`). */
function mockHomedSource(): TexPageSource {
  const source = fixtureSource();
  return {
    ...source,
    async overview(chat) {
      asked.push(chat);
      const read = await source.overview(chat);
      if (read.kind !== "ok") return read;
      const chats = read.value.chats.map((c) => (c.key === "g-team" ? { ...c, home: { context: "@context-lc", folder: "tex/groups/team-night-lamp" } } : c));
      return { ...read, value: { ...read.value, chats } };
    },
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockPushed.length = 0;
  mockRedirected.length = 0;
  Object.assign(mockNav, { index: 0, canGoBack: true, backs: 0, replaced: [] });
  asked.length = 0;
  mockAuth.signedIn = true;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tick = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
async function open(at: Record<string, string | string[]>) {
  mockParams.current = at;
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(TexPageScreen))));
  await tick();
}
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(id: string) {
  const el = byTestId(id);
  if (el === null) throw new Error(`no ${id}`);
  act(() => el.click());
  await tick();
}

describe("/tex/group/<words>", () => {
  test("opens that group's page, found among the person's own chats", async () => {
    await open({ words: "team-night-lamp" });
    expect(byTestId("tex-page-screen")).not.toBeNull();
    expect(asked).toContain("g-team");
    expect(container.textContent).toContain("Team Night");
  });

  test("words that name no chat of theirs show nothing of any chat", async () => {
    await open({ words: "calm-river-stone" });
    expect(byTestId("tex-group-not-yours")).not.toBeNull();
    expect(byTestId("tex-page-screen")).toBeNull();
    expect(asked).toEqual(["me"]);
  });

  test("moving around a group's page keeps the group's address", async () => {
    await open({ words: "team-night-lamp" });
    await press("tex-behind-advisor");
    expect(mockPushed).toEqual(["/tex/group/team-night-lamp/advisor"]);
  });

  test("a sub-page is a path under the group", async () => {
    await open({ words: "team-night-lamp", rest: ["advisor"] });
    expect(byTestId("tex-advisor-page")).not.toBeNull();
  });

  test("signed out comes back to the same sub-page", async () => {
    mockAuth.signedIn = false;
    await open({ words: "team-night-lamp", rest: ["routines"] });
    expect(mockRedirected).toEqual(["/login?next=%2Ftex%2Fgroup%2Fteam-night-lamp%2Froutines"]);
  });
});

/*
  The way out of the hub (Dev2, 2026-11-06). SABOTAGE: always `router.back()`
  and "nothing behind" and "Tex pages behind" fail.
*/
describe("‹ Notes on the hub", () => {
  test("opened from the app, goes back to where it was opened", async () => {
    await open({ handle: "@seyi" });
    await press("tex-exit");
    expect(mockNav.backs).toBe(1);
    expect(mockNav.replaced).toEqual([]);
  });

  test("with nothing behind it (a link from a text), goes to the notes", async () => {
    mockNav.canGoBack = false;
    await open({ handle: "@seyi" });
    await press("tex-exit");
    expect(mockNav.backs).toBe(0);
    expect(mockNav.replaced).toEqual(["/console"]);
  });

  test("with Tex pages behind it, leaves Tex instead of walking them", async () => {
    mockNav.index = 2;
    await open({ handle: "@seyi" });
    await press("tex-exit");
    expect(mockNav.backs).toBe(0);
    expect(mockNav.replaced).toEqual(["/console"]);
  });
});

describe("/tex/@<handle>", () => {
  test("a sub-page is a path, and moving around writes paths", async () => {
    await open({ handle: "@seyi", rest: ["advisor"] });
    expect(byTestId("tex-advisor-page")).not.toBeNull();
    expect(new Set(asked)).toEqual(new Set(["me"]));
    await open({ handle: "@seyi" });
    await press("tex-behind-mailcheck");
    expect(mockPushed).toEqual(["/tex/@seyi/mailcheck"]);
  });
});
