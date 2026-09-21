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
 *  4. `Stranded`'s Copy note dropped — the panel back to showing words it
 *     will not let anybody take off the device.
 *     → **1 fails**: `the words are reachable whatever the gateway does`.
 *  5. `Stranded` calling `meetings.retry` for every state, ignoring what
 *     `landing.retry` says — a sync retry over a finalize that never
 *     completed, which is the wrong call and a silent one.
 *     → **1 fails**: `offers the retry the note screen has always had`.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over them.
let mockLive: unknown = null;
let mockRecords: unknown[] = [];
const mockCalls: { name: string; args: unknown[] }[] = [];

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

/*
  The controller, as a spy. The panel is now a place a meeting is *worked* —
  renamed, noted in, stopped — so what these tests check is that each control
  reaches the one controller call that owns that change, and never a second
  store of its own.
*/
jest.mock("../features/meetings/controller", () => {
  const actual = jest.requireActual("../features/meetings/controller") as {
    recordElapsedMs: unknown;
  };
  const record = (name: string) => (...args: unknown[]) => {
    mockCalls.push({ name, args });
    return Promise.resolve();
  };
  return {
    recordElapsedMs: actual.recordElapsedMs,
    meetings: {
      setTitle: record("setTitle"),
      setNotes: record("setNotes"),
      end: record("end"),
      discard: record("discard"),
      pause: record("pause"),
      resume: record("resume"),
      retry: record("retry"),
      retryFinalize: record("retryFinalize"),
    },
  };
});

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
    session: {
      id: "m1",
      title: "Pricing sync",
      state,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      recordedMs: 0,
      attendees: [],
      source: { kind: "in-person" },
      notes: "",
      transcript: [],
      notePath: null,
      enhanced: null,
      log: [],
    },
    runningSince: new Date(Date.now() - 60_000).toISOString(),
    destination: { kind: "personalInbox", contextSlug: "seyi", folder: "0-inbox/meetings" },
  };
}

/** A meeting that has already been filed. */
function filed() {
  return {
    session: {
      id: "m0",
      title: "Leads call",
      state: "complete",
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      recordedMs: 2_460_000,
      attendees: [],
      source: { kind: "in-person" },
      notes: "- [0:12] LK owns the transparency page",
      transcript: [],
      notePath: "0-inbox/meetings/2026-09-18-leads-call.md",
      enhanced: null,
      log: [],
    },
    runningSince: null,
    destination: { kind: "personalInbox", contextSlug: "seyi", folder: "0-inbox/meetings" },
  };
}

/**
 * A meeting that ended and never reached the bucket.
 *
 * The owner's own, from the bug report: *"This meeting randomly stopped
 * working, Trying to open it it says it hasnt been written to context, how do
 * I get it???"* — a real recording, 31 minutes of it, and a panel with one
 * sentence and nothing to press.
 */
function stranded(over: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    session: {
      id: "m0",
      title: "Jhon / Seyi",
      state: "failed",
      failureReason: "the upload timed out.",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      recordedMs: 1_860_000,
      attendees: [],
      source: { kind: "unknown" },
      notes: "- [0:12] LK owns the transparency page",
      transcript: [],
      notePath: null,
      enhanced: null,
      log: [],
      ...session,
    },
    runningSince: null,
    destination: { kind: "personalInbox", contextSlug: "seyi", folder: "0-inbox/meetings" },
    ...over,
  };
}

/** react-native-web renders `TextInput` as an `input`; this is how one is typed in. */
function type(field: HTMLElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockLive = null;
  mockRecords = [];
  mockCalls.length = 0;
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
    onOpenNote?: ((href: string) => void) | null;
    asked?: { text: string; at: number } | null;
    started?: number | null;
    newChat?: number | null;
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
        started: options.started ?? null,
        newChat: options.newChat ?? null,
        onOpenNote: options.onOpenNote === undefined ? () => {} : options.onOpenNote,
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

    expect(panel.find("aside-meeting-title")).not.toBeNull();
    expect(panel.find("aside-live-clock")).not.toBeNull();
    expect(panel.find("aside-no-meeting")).toBeNull();
  });

  test("and where the note is going, without anybody having been asked", () => {
    /*
      The sheet used to name the folder before the microphone opened. It is
      gone, so the card is the only place this is said — and it is said for the
      whole length of the recording rather than once, in front of it.
    */
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");
    expect(panel.text()).toContain("0-inbox/meetings");
  });

  test("the name can be changed while it runs, and goes to the one store that owns it", () => {
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");

    const field = panel.find("aside-meeting-title");
    expect(field).not.toBeNull();
    type(field!, "Leads call");

    expect(mockCalls).toContainEqual({ name: "setTitle", args: ["m1", "Leads call"] });
  });

  test("a typed note lands in the meeting's own notes, stamped with its clock", () => {
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");

    type(panel.find("aside-meeting-note-field")!, "ops goes async");
    panel.press("aside-meeting-note-add");

    const note = mockCalls.find((call) => call.name === "setNotes");
    expect(note).toBeDefined();
    expect(note!.args[0]).toBe("m1");
    expect(String(note!.args[1])).toMatch(/^- \[\d+:\d\d\] ops goes async$/);
  });

  test("an empty composer writes nothing", () => {
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-note-add");
    expect(mockCalls.some((call) => call.name === "setNotes")).toBe(false);
  });

  test("stopping is one press, and it is the controller's own end", () => {
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-stop");
    expect(mockCalls).toContainEqual({ name: "end", args: [] });
  });

  test("discarding asks twice, because it is the one control that destroys a recording", () => {
    mockLive = recording();
    const panel = mount();
    panel.press("aside-tab-meetings");

    panel.press("aside-meeting-discard");
    expect(mockCalls.some((call) => call.name === "discard")).toBe(false);

    panel.press("aside-meeting-discard-confirm");
    expect(mockCalls).toContainEqual({ name: "discard", args: ["m1"] });
  });

  test("a paused meeting offers Resume rather than Pause", () => {
    mockLive = recording("paused");
    const panel = mount();
    panel.press("aside-tab-meetings");
    expect(panel.find("aside-meeting-pause")?.getAttribute("aria-label")).toBe(
      "Resume recording",
    );
  });
});

describe("asking for a meeting is what takes the tab", () => {
  /**
   * `tabs.ts` refuses a *starting* meeting the tab, because a panel that swaps
   * out from under a composer loses the question somebody was typing. Pressing
   * New meeting is that person asking, in the menu's own words — the same trade
   * the ⌘K handoff makes, pointed the other way.
   */
  test("the + menu's New meeting opens the panel on Meetings", () => {
    mockLive = recording();
    const panel = mount({ started: 1 });
    expect(panel.find("aside-meetings")).not.toBeNull();
    expect(panel.find("aside-chat")).toBeNull();
  });

  test("and a meeting that merely starts still only marks the tab", () => {
    mockLive = recording();
    const panel = mount();
    expect(panel.find("aside-chat")).not.toBeNull();
    expect(panel.find("aside-tab-meetings-dot")).not.toBeNull();
  });
});

describe("meetings that have already been recorded", () => {
  test("they are listed when nothing is running", () => {
    mockRecords = [filed()];
    const panel = mount();
    panel.press("aside-tab-meetings");
    expect(panel.text()).toContain("Leads call");
  });

  test("and one opens in the panel rather than on a page", () => {
    /*
      The whole of the owner's first complaint: *"meetings should stop opening
      up in the big ugly page and only open up in the side panel"*. Nothing in
      this panel navigates.
    */
    mockRecords = [filed()];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.find("aside-meeting-back")).not.toBeNull();
    expect(panel.text()).toContain("0-inbox/meetings/2026-09-18-leads-call.md");
    expect(panel.text()).toContain("LK owns the transparency page");
  });

  test("its note opens in the editor behind the panel, which is where a file is edited", () => {
    mockRecords = [filed()];
    const opened: string[] = [];
    const panel = mount({ onOpenNote: (href) => opened.push(href) });
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");
    panel.press("aside-meeting-open-note");

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("2026-09-18-leads-call.md");
  });

  test("a filed meeting offers no second editor of its own", () => {
    // By then it is a Markdown file, and the console has an editor for those.
    // A rename here would write to a record whose note has already been filed.
    mockRecords = [filed()];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");
    expect(panel.find("aside-meeting-title")).toBeNull();
    expect(panel.find("aside-meeting-note-field")).toBeNull();
  });
});

/**
 * THE PANEL IS NOT A DEAD END FOR A MEETING THAT DID NOT LAND.
 *
 * The owner recorded 31 minutes, opened the meeting in this panel, and read
 * *"This meeting has not been written to your context yet"* with nothing
 * beside it — no reason, no Retry, no way to read the words. Their question
 * was "how do I get it???", and the panel's answer was the sentence again.
 *
 * Everything asserted below already existed on `/meetings/:id`. What was
 * missing was this surface reaching it, which is why `landing.ts` is a module
 * — and why these tests check the *panel* while `meetingsLanding.test.ts`
 * checks the rule.
 */
describe("a meeting that never reached the bucket", () => {
  test("says why, rather than only that it did not", () => {
    mockRecords = [stranded()];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.text()).toContain("Not filed");
    expect(panel.text()).toContain("the upload timed out.");
  });

  test("and offers the retry the note screen has always had", () => {
    mockRecords = [stranded()];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");
    panel.press("aside-meeting-retry");

    expect(mockCalls.map((call) => call.name)).toContain("retryFinalize");
  });

  test("a refusal gets the sync retry instead, because that is the one that clears it", () => {
    mockRecords = [
      stranded({ rejection: { code: "meeting_forbidden", message: "gateway answered 403", noticedAt: 0 } }, { state: "complete" }),
    ];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.text()).toContain("Connect it again from Settings");
    expect(panel.text()).not.toContain("403");
    panel.press("aside-meeting-retry");
    expect(mockCalls.map((call) => call.name)).toContain("retry");
  });

  test("a session that captured nothing is offered no retry of nothing", () => {
    mockRecords = [stranded({}, { state: "empty", emptyReason: "no audio reached the recorder.", notes: "", transcript: [] })];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.text()).toContain("Nothing was captured");
    expect(panel.find("aside-meeting-retry")).toBeNull();
  });

  test("one still on its way says so, and is not something to press at", () => {
    mockRecords = [stranded({}, { state: "finalizing", failureReason: undefined })];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.text()).toContain("Not in your bucket yet");
    expect(panel.find("aside-meeting-retry")).toBeNull();
  });

  test("and the words are reachable whatever the gateway does, which is the actual ask", async () => {
    /*
      The way out of the device. A meeting can be complete, correct, on the
      phone and reachable by nothing else, and when it is, the clipboard is the
      whole of what somebody can do about it — `renderMeetingNote`'s output,
      the same function the gateway writes the bucket with, so what they paste
      is the note they would have had.

      jsdom has no `navigator.clipboard`, so this asserts the control is there
      and reaches the press; `meetingsScreens.test.ts` is where the bytes on
      the clipboard are checked.
    */
    mockRecords = [stranded()];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.find("aside-meeting-copy")).not.toBeNull();
    panel.press("aside-meeting-copy");
    await settle();
    expect(panel.text()).toContain("Couldn't reach the clipboard");
  });

  test("a filed meeting this device cannot address says where it is, not that it is lost", () => {
    /*
      `noteEditorHref` refuses to guess a context: a record from a build before
      `destination` existed has no slug, so there is no honest link even though
      the note is in the bucket. The panel used to answer that with "has not
      been written to your context yet", which is the one thing that is flatly
      false about it — the path is printed directly above the sentence.
    */
    mockRecords = [
      stranded({ destination: null }, { state: "complete", notePath: "0-inbox/meetings/a.md" }),
    ];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.text()).not.toContain("has not been written");
    expect(panel.text()).toContain("this device cannot address it");
    expect(panel.find("aside-meeting-retry")).toBeNull();
  });

  test("a filed meeting keeps its door to the editor and grows no landing", () => {
    mockRecords = [filed()];
    const panel = mount();
    panel.press("aside-tab-meetings");
    panel.press("aside-meeting-row-m0");

    expect(panel.find("aside-meeting-open-note")).not.toBeNull();
    expect(panel.find("aside-meeting-retry")).toBeNull();
    expect(panel.text()).not.toContain("Not in your bucket yet");
  });
});
