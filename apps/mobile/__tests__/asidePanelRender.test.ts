/**
 * @jest-environment jsdom
 */

/**
 * THE RIGHT PANEL'S CONTENTS, ON THE GLASS.
 *
 * `asideTabs.test.ts` proves the rules; `appFrameRender.test.ts` proves the
 * frame puts a panel where the density says. This is the part in between —
 * that the panel is wired to those rules rather than having its own opinion —
 * and the one claim that is only true of a rendered tree:
 *
 * **a meeting starting does not take the tab, and marks it instead.** The
 * whole trade rests on that mark, so it is asserted in both directions and in
 * the accessible name as well as on the glass. A dot a screen reader cannot
 * see is a dot that only exists for people who can look at the screen, and
 * missing a recording is the failure this is guarding against.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `AsidePanel` computing its tab as `live ? "meetings" : showing` — the
 *     seize `tabs.ts` refuses, written as somebody helpful would write it.
 *     → **1 fails**: `a meeting does not move the tab out from under a
 *     question`.
 *
 *     I predicted the dot test would go too, and it does not: the dot reads
 *     `showing`, which the seize does not touch, so the mark stays correct
 *     while the *body* swaps underneath it. Worth recording, because it means
 *     the two are genuinely independent — the dot cannot stand in for the tab
 *     rule, and a version of this file with only the dot asserted would have
 *     shipped the seize.
 *  2. The dot's `accessibilityLabel` branch dropped, so the tab is named
 *     "Meetings" whether or not one is running.
 *     → **1 fails**: `the mark is in the name as well as beside it`.
 *  3. `MeetingsTab` rendering nothing when `live` is null.
 *     → **1 fails**: `an empty tab says what would put something in it`.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
let mockLive: unknown = null;

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({ live: mockLive }),
  useTick: () => 0,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsidePanel } from "../features/console/aside/AsidePanel";
import { NO_MEETING } from "../features/console/aside/tabs";
import { createStubEngine } from "../features/agent/engine";
import type { AgentPage } from "../features/agent/page";

const PLACE = {
  context: { slug: "seyi", personal: true, role: "owner" },
  note: { path: "1-projects/pricing.md", etag: "a1", visibility: "team", readable: true, unsaved: false },
  route: "/console/@seyi",
  meetingLive: false,
  query: null,
} as AgentPage;

/** A running meeting, in the shape `MeetingsSnapshot.live` carries. */
function recording(state: "recording" | "paused" = "recording") {
  return {
    session: { id: "m1", title: "Pricing sync", state, startedAt: Date.now() - 60_000, log: [] },
    runningSince: Date.now() - 60_000,
  };
}

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockLive = null;
});

/** Let the stub engine's promise resolve and React commit the answer. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(
  options: {
    onOpenMeeting?: ((id: string) => void) | null;
    asked?: { text: string; at: number } | null;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(AsidePanel, {
        engine: createStubEngine(),
        place: PLACE,
        asked: options.asked ?? null,
        onOpenMeeting: options.onOpenMeeting === undefined ? () => {} : options.onOpenMeeting,
      }),
    );
  });
  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    container,
    find,
    text: () => container.textContent ?? "",
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

describe("the two tabs", () => {
  test("a panel opens on chat, with somewhere to type", () => {
    const panel = mount();
    expect(panel.find("aside-chat")).not.toBeNull();
    expect(panel.find("agent-input")).not.toBeNull();
    expect(panel.find("aside-meetings")).toBeNull();
  });

  test("pressing Meetings shows meetings", () => {
    const panel = mount();
    panel.press("aside-tab-meetings");
    expect(panel.find("aside-meetings")).not.toBeNull();
    expect(panel.find("aside-chat")).toBeNull();
  });

  test("an empty tab says what would put something in it", () => {
    const panel = mount();
    panel.press("aside-tab-meetings");
    expect(panel.find("aside-no-meeting")).not.toBeNull();
    expect(panel.text()).toContain(NO_MEETING.slice(0, 24));
  });
});

describe("a meeting, while you are looking elsewhere", () => {
  /**
   * The decision this panel rests on. A meeting can start while somebody is
   * halfway through typing, and a panel that swapped tabs would lose the
   * question and answer one nobody asked.
   */
  test("a meeting does not move the tab out from under a question", () => {
    mockLive = recording();
    const panel = mount();
    expect(panel.find("aside-chat")).not.toBeNull();
    expect(panel.find("aside-meetings")).toBeNull();
  });

  test("the dot is what says a meeting is running", () => {
    mockLive = recording();
    const panel = mount();
    expect(panel.find("aside-tab-meetings-dot")).not.toBeNull();

    // ...and it goes once you are reading that tab, because a mark on the
    // thing you are looking at means nothing.
    panel.press("aside-tab-meetings");
    expect(panel.find("aside-tab-meetings-dot")).toBeNull();
  });

  test("and there is no dot with no meeting behind it", () => {
    const panel = mount();
    expect(panel.find("aside-tab-meetings-dot")).toBeNull();
  });

  test("the mark is in the name as well as beside it", () => {
    mockLive = recording();
    const panel = mount();
    const tab = panel.find("aside-tab-meetings");
    expect(tab?.getAttribute("aria-label")).toBe("Meetings, recording");

    mockLive = null;
    const quiet = mount();
    expect(quiet.find("aside-tab-meetings")?.getAttribute("aria-label")).toBe("Meetings");
  });
});

describe("a question handed over from ⌘K", () => {
  /**
   * The panel opens with the answer already arriving, which is the whole
   * point of the palette row: somebody has already typed the words, and
   * making them type them again is the reason nobody uses a second box.
   */
  test("it is asked, without anybody typing it again", async () => {
    const panel = mount({ asked: { text: "what did we decide about pricing?", at: 1 } });
    await settle();

    expect(panel.text()).toContain("what did we decide about pricing?");
    expect(panel.find("agent-turn-person")).not.toBeNull();
    // The stub answers by describing the room, so a reply landed too.
    expect(panel.find("agent-turn-agent")).not.toBeNull();
  });

  /**
   * A question arriving takes the tab, where a meeting does not — and the two
   * are not in tension. The meeting is refused because nobody asked for it;
   * this *is* somebody asking, and landing them anywhere but the answer would
   * be the same surprise pointed the other way.
   */
  test("and it takes the tab, even from a running meeting", async () => {
    mockLive = recording();
    const panel = mount({ asked: { text: "what is this?", at: 1 } });
    await settle();

    expect(panel.find("aside-chat")).not.toBeNull();
    expect(panel.find("aside-meetings")).toBeNull();
  });

  test("a panel nobody asked through opens with an empty transcript", async () => {
    const panel = mount();
    await settle();
    expect(panel.find("agent-turn-person")).toBeNull();
    expect(panel.find("agent-empty")).not.toBeNull();
  });
});

describe("what a running meeting shows", () => {
  test("which one, and for how long", () => {
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");

    expect(panel.text()).toContain("Pricing sync");
    expect(panel.find("aside-live-clock")).not.toBeNull();
    expect(panel.find("aside-no-meeting")).toBeNull();
  });

  test("a paused meeting says it is paused rather than recording", () => {
    mockLive = recording("paused");
    const panel = mount();
    panel.press("aside-tab-meetings");
    expect(panel.text()).toContain("Paused");
    expect(panel.text()).not.toContain("The note lands wherever");
  });

  test("pressing it opens the meeting", () => {
    mockLive = recording();
    const opened: string[] = [];
    const panel = mount({ onOpenMeeting: (id) => opened.push(id) });
    panel.press("aside-tab-meetings");
    panel.press("aside-live-meeting");
    expect(opened).toEqual(["m1"]);
  });

  /**
   * The transport is deliberately not here — Start, pause and End live on the
   * bar and on the meeting's own screen, and a fourth place to press End is a
   * fourth place to get "did that work?" wrong. Asserted as an absence,
   * because a control that arrived later would arrive silently.
   */
  test("and offers no transport of its own", () => {
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");
    for (const control of ["aside-end", "aside-pause", "aside-resume", "aside-stop"]) {
      expect(panel.find(control)).toBeNull();
    }
    expect(panel.text()).not.toContain("End");
  });

  test("a surface with nowhere to navigate draws the card and no button", () => {
    mockLive = recording();
    const panel = mount({ onOpenMeeting: null });
    panel.press("aside-tab-meetings");
    const card = panel.find("aside-live-meeting");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).not.toBe("button");
  });
});
