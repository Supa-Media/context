/**
 * @jest-environment jsdom
 */

/**
 * THE BAR THAT SAYS A MEETING DID NOT MAKE IT.
 *
 * ## What it is for
 *
 * Until this existed, a meeting that failed to reach the bucket was visible in
 * two places and both of them required having gone looking: the meeting's own
 * page, and the console's Meetings panel. The recording bar renders `null` for
 * anything that is not live, the aside tab's dot reads `meetingLive` only, and
 * nothing in this app imports `expo-notifications`. So the owner recorded 31
 * minutes, the finalize got stuck, and the app said nothing anywhere.
 *
 * Their instruction was *"it should be very LOUD and dramatic if something
 * went wrong so the user can resume/restart"*. Loud is only half of it — the
 * half these checks are mostly about is that the press is *on the bar*, so
 * somebody who did not know there was anything to do still does one thing.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The `snapshot.live !== null` stand-down removed, so the bar draws over a
 *     running meeting's transport.
 *     → **1 fails**: `it stands down while something is recording`.
 *  2. `strandedMeetings` swapped for "every record with no note path", the
 *     tempting simplification.
 *     → **2 fail**: `a meeting merely on its way is not shouted about` and
 *     `nothing is said about a meeting that captured nothing`.
 *  3. Retry wired to `meetings.retry` for every kind, ignoring `landing.retry`.
 *     → **1 fails**: `a failed finalize is retried as a finalize`.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

let mockLive: unknown = null;
let mockRecords: unknown[] = [];
const mockCalls: { name: string; args: unknown[] }[] = [];
let mockPathname = "/console/@seyi";

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({
    live: mockLive,
    records: mockRecords,
    ending: null,
    audio: {},
    offline: false,
  }),
  useTick: () => 0,
}));

const pushed: string[] = [];
jest.mock("expo-router", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: (href: string) => pushed.push(href) }),
}));

jest.mock("../features/app/bottomChrome", () => ({
  useBottomChromeHeight: () => 0,
  floatingStackBottom: () => 12,
}));

jest.mock("../features/meetings/controller", () => {
  const record = (name: string) => (...args: unknown[]) => {
    mockCalls.push({ name, args });
    return Promise.resolve();
  };
  return { meetings: { retry: record("retry"), retryFinalize: record("retryFinalize") } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { StrandedBar } from "../features/meetings/components/StrandedBar";
import { ERRORS } from "../features/meetings/protocol";

/* -------------------------------------------------------------------------- */

function meeting(
  over: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
): unknown {
  return {
    version: 1,
    workspaceId: "ws1",
    session: {
      id: "m0",
      title: "Jhon / Seyi",
      state: "failed",
      failureReason: "the finalize did not complete.",
      startedAt: "2026-09-21T13:25:00.000Z",
      recordedMs: 1_860_000,
      attendees: [],
      source: { kind: "unknown" },
      notes: "the bit that must not be lost",
      transcript: [],
      notePath: null,
      enhanced: null,
      flags: [],
      log: [],
      ...session,
    },
    acked: { metadata: null, segmentIds: [], notes: null, finalized: false },
    destination: null,
    runningSince: null,
    updatedAt: 0,
    attempts: 0,
    ...over,
  };
}

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockLive = null;
  mockRecords = [];
  mockCalls.length = 0;
  pushed.length = 0;
  mockPathname = "/console/@seyi";
});

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(StrandedBar, { bottomInset: 0 })));
  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
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

/* -------------------------------------------------------------------------- */

describe("when it is up", () => {
  test("nothing wrong, nothing on screen", () => {
    mockRecords = [meeting({}, { state: "complete", notePath: "0-inbox/meetings/a.md" })];
    expect(mount().find("stranded-bar")).toBeNull();
  });

  test("a meeting merely on its way is not shouted about", () => {
    // The queue working is not a problem, and a bar that came up for it would
    // be up after every meeting anybody records.
    mockRecords = [meeting({}, { state: "finalizing" })];
    expect(mount().find("stranded-bar")).toBeNull();
  });

  test("nothing is said about a meeting that captured nothing", () => {
    mockRecords = [meeting({}, { state: "empty", emptyReason: "no audio reached the recorder." })];
    expect(mount().find("stranded-bar")).toBeNull();
  });

  test("a failed meeting brings it up, named", () => {
    mockRecords = [meeting()];
    const bar = mount();
    expect(bar.find("stranded-bar")).not.toBeNull();
    expect(bar.text()).toContain("Jhon / Seyi");
    expect(bar.text()).toContain("Not saved");
  });

  test("and so does a refusal", () => {
    mockRecords = [
      meeting(
        { rejection: { code: ERRORS.forbidden, message: "403", noticedAt: 0 } },
        { state: "complete" },
      ),
    ];
    expect(mount().find("stranded-bar")).not.toBeNull();
  });

  test("it stands down while something is recording", () => {
    /*
      `RecordingBar` holds this exact slot — same inset, same floated edge —
      and `zIndex` cannot arbitrate between two different stacking contexts.
      It is also the right call on its own: somebody recording now is the one
      person who must not be pulled away from it.
    */
    mockRecords = [meeting()];
    mockLive = meeting({}, { id: "m9", state: "recording" });
    expect(mount().find("stranded-bar")).toBeNull();
  });

  test("and on the meeting's own screen, which says all of this properly", () => {
    mockRecords = [meeting()];
    mockPathname = "/meetings/m0";
    expect(mount().find("stranded-bar")).toBeNull();
  });

  test("several stranded meetings are counted, not listed illegibly", () => {
    mockRecords = [meeting(), meeting({}, { id: "m1", title: "Board sync" })];
    const bar = mount();
    expect(bar.text()).toContain("Jhon / Seyi");
    expect(bar.text()).toContain("+1");
  });
});

describe("what it offers", () => {
  test("a failed finalize is retried as a finalize", () => {
    mockRecords = [meeting()];
    const bar = mount();
    bar.press("stranded-bar-retry");
    expect(mockCalls.map((call) => call.name)).toEqual(["retryFinalize"]);
  });

  test("a refusal takes the sync retry, which is the one that clears it", () => {
    mockRecords = [
      meeting(
        { rejection: { code: ERRORS.forbidden, message: "403", noticedAt: 0 } },
        { state: "complete" },
      ),
    ];
    const bar = mount();
    bar.press("stranded-bar-retry");
    expect(mockCalls.map((call) => call.name)).toEqual(["retry"]);
  });

  test("the body opens the meeting, where the reason and Copy note are", () => {
    mockRecords = [meeting()];
    const bar = mount();
    bar.press("stranded-bar-open");
    expect(pushed).toEqual(["/meetings/m0"]);
  });

  test("it announces itself as an alert, with the meeting named in it", () => {
    // A bar a screen reader reads as decoration is a bar that only exists for
    // people who can look at it — and the failure it is about is silent.
    mockRecords = [meeting()];
    const node = mount().find("stranded-bar")!;
    expect(node.getAttribute("role")).toBe("alert");
    expect(node.getAttribute("aria-label")).toContain("Jhon / Seyi");
    expect(node.getAttribute("aria-label")).toContain("not saved");
  });

  test("there is no way to dismiss it — it goes when the meeting is filed", () => {
    /*
      The whole difference between this and a toast. A meeting that did not
      save is still not saved eight seconds later.
    */
    mockRecords = [meeting()];
    const bar = mount();
    expect(bar.find("stranded-bar-dismiss")).toBeNull();
    expect(bar.find("stranded-bar-close")).toBeNull();
  });
});
