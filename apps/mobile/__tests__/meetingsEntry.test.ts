/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The way in to meeting capture.
 *
 * Meeting capture shipped complete and unreachable: `/meetings` had a list, a
 * live screen and a working recorder, and **nothing in the app navigated to
 * it** — no `href`, no `router.push`, no rail entry, no button anywhere outside
 * `features/meetings/`. The owner asked "how do I record a meeting?" while
 * looking at a note, and the honest answer was "type the URL".
 *
 * Every claim the entry point makes is below, each one sabotaged, with the
 * measurement recorded beside it.
 *
 * ## What jsdom can and cannot prove here
 *
 * jsdom lays nothing out, so *no* assertion below is a layout assertion. What
 * it can read is react-native-web's inline geometry — `position`, `bottom`, a
 * declared height — which is enough for the one geometric claim that matters:
 * the entry is in the rail's pinned **head**, in normal flow at the top of the
 * panel, while the recording bar is absolutely positioned against the
 * **bottom** of the glass. Two objects at opposite edges cannot cover each
 * other, and that is a claim about the declarations rather than about pixels.
 *
 * **The pixels have not been checked on a device or in a browser for this
 * change**, and that is stated rather than assumed: `appFrameRender.test.ts`
 * makes the same split and records where its numbers were verified. What is
 * unverified here is how the pinned head *looks* at each of the two rail modes
 * a layout can actually be in — `full` and `icons`; see the enumeration below
 * for where `sheet` went — and how the back control on `/meetings` sits against
 * the reading margin. What is verified is that they exist, that they are
 * reachable, and that pressing them does what they say.
 */

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const pushed: string[] = [];
/*
  `mock`-prefixed so `jest.mock`'s hoisted factory may close over them —
  babel-plugin-jest-hoist refuses any other out-of-scope name.
*/
const mockReplaced: string[] = [];
let mockBacks = 0;
/** Whether this navigator has anywhere to go back to. See the round-trip tests. */
let mockHistory = true;
jest.mock("expo-router", () => ({
  useRouter: () => ({
    replace: (href: string) => mockReplaced.push(href),
    push: (href: string) => pushed.push(href),
    back: () => {
      mockBacks += 1;
    },
    canGoBack: () => mockHistory,
  }),
  usePathname: () => "/console/@seyi",
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { ConsoleRail } =
  require("../features/console/ConsoleRail") as typeof import("../features/console/ConsoleRail");
const { RecordingBar } =
  require("../features/meetings/components/RecordingBar") as typeof import("../features/meetings/components/RecordingBar");
const { MEETINGS_ROUTE } =
  require("../features/meetings/route") as typeof import("../features/meetings/route");
const { MeetingsListScreen } =
  require("../features/meetings/MeetingsListScreen") as typeof import("../features/meetings/MeetingsListScreen");
const { CONSOLE_ROOT } =
  require("../features/console/nav") as typeof import("../features/console/nav");
const { meetings } =
  require("../features/meetings/controller") as typeof import("../features/meetings/controller");
const { fakeGateway } =
  require("../features/meetings/fakeGateway") as typeof import("../features/meetings/fakeGateway");
const { fakeRecorder } =
  require("../features/meetings/capture/fake") as typeof import("../features/meetings/capture/fake");
const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
const { floatingStackBottom } =
  require("../features/app/bottomChrome") as typeof import("../features/app/bottomChrome");
const { layout } = require("../features/design/tokens") as typeof import("../features/design/tokens");
/* eslint-enable @typescript-eslint/no-require-imports */

type ConsoleData = import("../features/console/types").ConsoleData;
type RailMode = "full" | "icons" | "sheet";

/* -------------------------------------------------------------------------- */
/*                                  harness                                   */
/* -------------------------------------------------------------------------- */

/** The least `ConsoleData` the rail reads: its contexts and whether they landed. */
function railData(): ConsoleData {
  return {
    loading: false,
    contexts: [
      { id: "ctx-1", slug: "seyi", displayName: "seyi", role: "owner", kind: "personal", status: "ok" },
    ],
  } as unknown as ConsoleData;
}

interface Mounted {
  host: HTMLElement;
  root: Root;
  find: (testId: string) => HTMLElement | null;
  unmount: () => void;
}

function mount(element: Parameters<Root["render"]>[0]): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    root,
    find: (testId) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function rail(mode: RailMode, onOpenMeetings?: () => void): Mounted {
  return mount(
    createElement(ConsoleRail as never, {
      data: railData(),
      route: { kind: "context", slug: "seyi", view: "browse" },
      mode,
      onNavigate: () => {},
      account: createElement("div", { "data-testid": "account-block" }),
      onOpenMeetings,
    } as never),
  );
}

function click(node: Element): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function configure() {
  await act(async () => {
    meetings.reset();
    await meetings.configure({
      workspaceId: `ws-${Math.random().toString(36).slice(2)}`,
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder: fakeRecorder(),
      device: { platform: "web" },
      persistDebounceMs: 0,
    });
  });
}

/* -------------------------------------------------------------------------- */

describe("the entry point exists on both surfaces", () => {
  /**
   * Every mode a layout can actually be in.
   *
   * **`"sheet"` was in this list and is not any more**, and that is worth a
   * paragraph rather than a shorter array. `regionsFor` cannot return
   * `rail: "sheet"` at any density: a phone has no rail at all
   * (`features/app/frame.ts`) and medium and wide have a permanent column. The
   * arm survives on the type deliberately, and that file's own enumeration says
   * why — but a test enumerating it was asserting about a screen nobody can
   * reach, which is the opposite of what enumerating the modes is for.
   *
   * The phone's way in did not go with it; it moved. It is the seventh key on
   * the bottom row, and it is asserted on that surface in
   * `consoleChrome.test.ts` (`bottom-bar-meeting` is present, and pressing it
   * raises the sheet that asks) rather than being approximated here.
   *
   * SABOTAGE: rendered the entry only when `mode === "sheet"`.
   * MEASURED: this test failed on `full` and on `icons`; nothing else in the
   * suite noticed, which is the whole reason it enumerates the modes.
   */
  test.each(["full", "icons"] as RailMode[])(
    "the rail carries it at %s",
    (mode) => {
      const app = rail(mode, () => {});
      expect(app.find("rail-meetings")).not.toBeNull();
      app.unmount();
    },
  );

  test("the collapsed rail keeps the name it cannot draw", () => {
    // A rail that becomes a row of unlabelled glyphs to a screen reader is not
    // collapsed, it is broken — `ConsoleRail`'s own rule, and the mark is the
    // only thing left at this width, so it has to be the right one.
    const app = rail("icons", () => {});
    const entry = app.find("rail-meetings")!;
    expect(entry.getAttribute("aria-label")).toBe("Open meetings");
    expect(entry.querySelector('[data-icon="mic"]')).not.toBeNull();
    app.unmount();
  });

  test("a rail with nowhere to send anybody draws no entry", () => {
    /*
      The same rule `onClaimContext` and `onCreateWorkspace` follow: the landing
      page mounts a *picture* of the console, and an entry there would open a
      flow that immediately refuses for want of a session.

      SABOTAGE: drew the row unconditionally.
      MEASURED: this test failed; the two density tests above stayed green,
      because they pass a callback.
    */
    const app = rail("full");
    expect(app.find("rail-meetings")).toBeNull();
    app.unmount();
  });
});

describe("where it goes", () => {
  test("the route it names is a route this app actually has", () => {
    /*
      `contextMenu.test.ts`'s rule, one destination over: a menu item pointing
      nowhere is the "undefined" pill again. Expo Router builds its tree from
      the file system, so the file is the proof.
    */
    expect(MEETINGS_ROUTE).toBe("/meetings");
    expect(existsSync(join(__dirname, "..", "app", "(app)", "meetings", "index.tsx"))).toBe(true);
  });

  test("pressing it asks to be taken there", () => {
    const seen: number[] = [];
    const app = rail("full", () => seen.push(1));
    click(app.find("rail-meetings")!);
    expect(seen).toHaveLength(1);
    app.unmount();
  });

  /**
   * The wiring, which is the half a mounted rail cannot see.
   *
   * `ConsoleRail` takes a callback so it imports no router, so the only thing
   * a mounted test can prove is that the callback fires. What the callback
   * *does* lives in the console layout, which is a live Convex subscription
   * from its first line and is mounted by nothing in this suite. So it is read
   * rather than mounted — the same move `storageCodePosition.test.ts` makes for
   * a fact about the server asserted in another app.
   *
   * SABOTAGE: removed the `onOpenMeetings` prop from the layout's `ConsoleRail`.
   * MEASURED: this test failed and no other did — the rail went on rendering
   * nothing, silently, which is exactly the bug this branch exists to fix.
   */
  test("the console layout hands the rail somewhere to send them", () => {
    const source = readFileSync(
      join(__dirname, "..", "app", "(app)", "console", "_layout.tsx"),
      "utf8",
    );
    expect(source).toContain("MEETINGS_ROUTE");
    expect(source).toContain("onOpenMeetings");
  });
});

describe("a way in needs a way back", () => {
  /**
   * `/meetings` is outside the console, so nothing above it draws chrome: the
   * `(app)` stack sets `headerShown: false` and the meetings navigator paints a
   * background and a `Stack`. The live screen and the note screen each carry
   * their own back control; **the list had none**, which was invisible while
   * nothing navigated here and is a dead end the moment something does.
   *
   * SABOTAGE: deleted the control.
   * MEASURED: both tests below failed. Nothing else in the suite did — the
   * screen's own tests are about what it *claims*, not how you leave it.
   */
  test("the list goes back the way somebody came", async () => {
    await configure();
    mockHistory = true;
    mockBacks = 0;
    mockReplaced.length = 0;

    const app = mount(createElement(MeetingsListScreen));
    click(app.find("meetings-back")!);

    expect(mockBacks).toBe(1);
    expect(mockReplaced).toEqual([]);
    app.unmount();
  });

  /**
   * And the cold-start case, which is the one a guarded `back()` exists for: a
   * typed URL, a deep link, or a reload on the web has no entry behind it, and
   * `router.back()` there is a press that does nothing.
   *
   * `CONSOLE_ROOT` rather than a remembered origin — `nav.ts` calls it "the one
   * destination that is always meaningful", and it resolves to a context this
   * person can actually reach.
   */
  test("and to the console when there is no back", async () => {
    await configure();
    mockHistory = false;
    mockBacks = 0;
    mockReplaced.length = 0;

    const app = mount(createElement(MeetingsListScreen));
    click(app.find("meetings-back")!);

    expect(mockBacks).toBe(0);
    expect(mockReplaced).toEqual([CONSOLE_ROOT]);
    app.unmount();
    mockHistory = true;
  });
});

describe("starting a meeting is a consent moment, so the entry point never starts one", () => {
  /**
   * The decision this protects, verbatim: "Detection may *suggest*, and the
   * suggestion is a prompt with a 'not now' — a detector that silently starts
   * recording would be the same product with the indicator removed"
   * (`docs/decisions/meetings.md`, *Consent is the customer's*).
   *
   * A rail row that opened the microphone would be exactly that, one surface
   * over. The entry **navigates**; the record button on `/meetings` — beside
   * the sentence saying where the audio goes — is what records.
   *
   * SABOTAGE: made the entry call `meetings.start({ title: "New meeting" })`
   * before navigating.
   * MEASURED: this test failed on both assertions (`live` was a session and
   * `records` had one row). Every other test in this file stayed green,
   * including "pressing it asks to be taken there".
   */
  test("pressing it opens no microphone and writes no session", async () => {
    await configure();
    const app = rail("full", () => {});

    click(app.find("rail-meetings")!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(meetings.getSnapshot().live).toBeNull();
    expect(meetings.getSnapshot().records).toHaveLength(0);
    app.unmount();
  });
});

describe("it coexists with a recording that is already running", () => {
  /**
   * Two floating bars in the same 66pt of glass is worse than either
   * (`AppFrame`), which is why `bottomChrome.ts` exists and why the recording
   * bar stacks above the console's toolbar rather than replacing it. **The
   * entry point stays out of that glass altogether**: it is in the rail's
   * pinned head, at the top of a full-height panel, and the recording bar is
   * anchored to the bottom edge.
   *
   * **The arithmetic that used to end this paragraph has reversed, and it is
   * corrected rather than deleted.** It read: "That is the reason the entry is
   * not on the bottom toolbar, and it is not only aesthetic — at 390pt the
   * toolbar's pill is 286pt wide and its inner width 262, which six targets
   * already divide into 43.7pt against a 44pt floor. A seventh does not fit."
   * A seventh fits now, because `layout.bottomBarInset` went **52 → 24** when
   * the phone lost its left panel: the 286 was `390 − 2 × 52`, the pill is
   * `390 − 2 × 24 = 342` wide, 318 inside `bottomBarPad`, and seven targets are
   * **45.4pt** against the same 44pt floor. The phone's way in *is* that
   * seventh key; this rail row is the way in at medium and wide, where
   * `regionsFor` draws a status bar and no bottom bar at all.
   *
   * What has not changed is the reason for the *placement* above: the entry
   * stays out of the 66pt of glass the recording bar floats in.
   */
  test("both are on screen, and the entry is still the thing you press", async () => {
    await configure();
    await act(async () => {
      await meetings.start({ title: "Reboot Camp" });
    });

    const seen: number[] = [];
    // The order `(app)/_layout.tsx` mounts them in: the routed tree first, the
    // bar last, because later siblings paint over earlier ones.
    const app = mount(
      createElement(
        Fragment,
        null,
        createElement(ConsoleRail as never, {
          data: railData(),
          route: { kind: "context", slug: "seyi", view: "browse" },
          mode: "full",
          onNavigate: () => {},
          account: createElement("div", { "data-testid": "account-block" }),
          onOpenMeetings: () => seen.push(1),
        } as never),
        createElement(RecordingBar, { bottomInset: 34 }),
      ),
    );

    expect(app.find("recording-bar")).not.toBeNull();
    expect(app.find("rail-meetings")).not.toBeNull();
    click(app.find("rail-meetings")!);
    expect(seen).toHaveLength(1);

    app.unmount();
    await act(async () => {
      await meetings.end();
    });
  });

  /**
   * The geometry, in the only form jsdom can hold: the two are declared at
   * opposite edges.
   *
   * SABOTAGE: moved the entry out of the pinned head and into the rail's
   * account footer, beside sign-out — the tidy-looking placement, and the one
   * the recording bar lies across while a panel is up, because a panel over
   * the editor makes the frame publish a chrome height of zero and the bar
   * drops to `floatingStackBottom(34, 0)` = 34pt, occupying the bottom 100pt of
   * the glass.
   *
   * MEASURED, and the first version of this test was **vacuous**: it read the
   * children of `rail-head`'s own parent, which travels with the block, so the
   * footer placement passed all eleven checks. It is anchored on the rail's
   * root now — the three children in order — and the same sabotage then fails
   * here and only here.
   */
  test("the entry is at the head of the rail and the bar is against the glass", async () => {
    await configure();
    await act(async () => {
      await meetings.start({ title: "Reboot Camp" });
    });

    const app = rail("full", () => {});
    const bar = mount(createElement(RecordingBar, { bottomInset: 34 }));

    const head = app.find("rail-head")!;
    const entry = app.find("rail-meetings")!;
    expect(head.contains(entry)).toBe(true);

    /*
      The rail is head, then the scrolling list of contexts, then the account
      block — read off the rail's root, so this is a claim about where the head
      *is* rather than about what it contains. The head is first, which is the
      edge furthest from the floating band, and a long context list cannot push
      it anywhere. The last assertion is the one the footer sabotage trips.
    */
    const railChildren = Array.from(app.find("console-rail")!.children);
    expect(railChildren).toHaveLength(3);
    expect(railChildren[0]).toBe(head);
    const foot = railChildren[railChildren.length - 1]!;
    expect(foot.contains(app.find("account-block")!)).toBe(true);
    expect(foot.contains(entry)).toBe(false);

    // Nothing about the head is anchored to an edge; it is in normal flow.
    expect(window.getComputedStyle(head).position).not.toBe("absolute");

    // The bar is, and to the far one. 34 here rather than 25, because
    // `floatingGapFor` takes the larger of the home indicator and the gap.
    const slot = bar.find("recording-bar")!;
    const style = window.getComputedStyle(slot);
    expect(style.position).toBe("absolute");
    expect(Number.parseFloat(style.bottom)).toBe(floatingStackBottom(34, 0));
    // The band it occupies, from the bottom of the glass. Stated so that a
    // change to either number is a change to this line.
    expect(floatingStackBottom(34, 0) + layout.bottomBarHeight).toBe(100);

    bar.unmount();
    app.unmount();
    await act(async () => {
      await meetings.end();
    });
  });
});
