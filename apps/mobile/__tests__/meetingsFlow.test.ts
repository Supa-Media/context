/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Pressing the microphone key, and what happens before the microphone opens.
 *
 * ## The property this file exists for
 *
 * `docs/decisions/meetings.md` — *the way in is a rail entry, and it navigates
 * rather than records* — refuses a control that opens the microphone, because
 * "a detector that silently started recording would be the same product with
 * the indicator removed", and it says the record control belongs "beside the
 * sentence saying where the audio goes and what is kept". A key in the bottom
 * row is one surface further out than the rail row that argument was written
 * about, and the same thing is true of it.
 *
 * So the sheet **is** that disclosure, which is why it opens every time — a
 * remembered choice preselects a row and never skips the question. A version
 * that skipped it once the destination was known would move recording one tap
 * away from any sentence about the audio, on exactly the path somebody uses
 * most. `the sheet opens even when the choice is remembered, because it is
 * where the audio sentence is` is that property, and it is sabotaged below.
 *
 * ## Sabotage record
 *
 * Each applied, suite run, named test failed, reverted.
 *
 *  1. `startMeetingFlow` starts the meeting straight away when a destination
 *     is remembered, instead of opening the sheet.
 *     → 2 fail, led by `the sheet opens even when the choice is remembered,
 *     because it is where the audio sentence is`. Note which test does *not*
 *     catch it: `pressing the key opens no microphone` has nothing remembered,
 *     so the shortcut never fires there — which is exactly why the consent
 *     property needs a test of its own rather than being assumed to fall out
 *     of the others.
 *  2. The audio sentence is emptied out of the sheet.
 *     → `the sheet says what happens to the audio, beside the control that
 *     starts it` and the consent test fail.
 *  3. `startMeetingFlow` calls `controller.start` as well as opening the sheet.
 *     → 3 fail, led by `pressing the key opens no microphone and writes no
 *     session`.
 *  4. `chooseOffer` drops its `refusal !== null` guard.
 *     → `a refused row cannot be chosen by pressing it` fails. (The pure half
 *     is held separately in `meetingsDestination.test.ts`.)
 *  5. The sheet renders the offers branch for a viewer who owns no brain.
 *     → `somebody with no brain is offered their name, not a recording` fails.
 *  6. `confirm` starts the meeting without passing the chosen destination.
 *     → `the meeting that results is the one the sheet described` and `the
 *     default is what starts when nobody changes the selection` fail.
 *  7. `confirm` does not write the choice down.
 *     → `the choice is remembered for next time` fails.
 *  8. `confirm` drops its `blocked !== null` guard, and the sheet's Start is
 *     enabled regardless.
 *     → `a device with no context yet refuses Start rather than throwing`
 *     fails.
 *  9. The selection is an index into the resolver's live list again, rather
 *     than the destination it names.
 *     → 2 fail: `a row that stops being on offer leaves no Start that does
 *     nothing` and `a row that goes read-only under the sheet falls back
 *     rather than refusing`. Neither is caught by any of the eight above,
 *     because every one of them holds the context list still — which is the
 *     assumption the whole defect lived inside.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const pushed: string[] = [];
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href), replace: () => {}, back: () => {} }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { useMeetingFlow } =
  require("../features/meetings/useMeetingFlow") as typeof import("../features/meetings/useMeetingFlow");
const { meetings } =
  require("../features/meetings/controller") as typeof import("../features/meetings/controller");
const { fakeGateway } =
  require("../features/meetings/fakeGateway") as typeof import("../features/meetings/fakeGateway");
const { fakeRecorder } =
  require("../features/meetings/capture/fake") as typeof import("../features/meetings/capture/fake");
const { rememberDestination, recallDestination } =
  require("../features/meetings/destination") as typeof import("../features/meetings/destination");
const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
/* eslint-enable @typescript-eslint/no-require-imports */

type Store = ReturnType<typeof memoryStore>;
type Recorder = ReturnType<typeof fakeRecorder>;

const OWN = { slug: "testagent1", kind: "personal", role: "owner" };
const SHARED = { slug: "field-notes", kind: "shared", role: "editor" };
const READ_ONLY = { slug: "field-notes", kind: "shared", role: "member" };

const IN_A_PROJECT = {
  kind: "currentPage" as const,
  contextSlug: "field-notes",
  folder: "1-projects/portal",
  label: "1-projects/portal",
};

/* -------------------------------------------------------------------------- */

interface Mounted {
  rerender: (next: ReactElement) => void;
  unmount: () => void;
}

function mount(element: ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    /** Re-render with different props, for a list that changes under the sheet. */
    rerender: (next: ReactElement) => {
      act(() => root.render(next));
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** The bottom row's microphone key, as far as this feature is concerned. */
function Harness(props: Parameters<typeof useMeetingFlow>[0]): ReactElement {
  const flow = useMeetingFlow(props);
  return createElement(
    "div",
    null,
    createElement("button", { "data-testid": "mic", onClick: flow.startMeetingFlow }, "mic"),
    flow.sheet,
  );
}

function press(testId: string): void {
  const target = document.body.querySelector(`[data-testid="${testId}"]`);
  if (target === null) throw new Error(`no control named ${testId}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function shown(testId: string): boolean {
  return document.body.querySelector(`[data-testid="${testId}"]`) !== null;
}

function text(): string {
  return document.body.textContent ?? "";
}

async function configure(): Promise<{ store: Store; recorder: Recorder }> {
  const store = memoryStore();
  const recorder = fakeRecorder();
  await act(async () => {
    meetings.reset();
    await meetings.configure({
      workspaceId: "ws-1",
      store,
      gateway: fakeGateway(),
      recorder,
      device: { platform: "web" },
      persistDebounceMs: 0,
    });
  });
  return { store, recorder };
}

/** Let the flow's own store read and the controller's writes settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

beforeEach(() => {
  pushed.length = 0;
  /*
    React Native Web's `Modal` portals out of the host element, so the sheet is
    read off `document.body` rather than off a container — which means a test
    that fails before it unmounts leaves a live harness behind, and the next
    `press("mic")` finds *its* key. Two tests were silently driving a previous
    test's tree before this line existed.
  */
  document.body.replaceChildren();
});

/* -------------------------------------------------------------------------- */

describe("the key asks, it does not record", () => {
  test("pressing the key opens no microphone and writes no session", async () => {
    /*
      The rail entry's rule one surface out. Nothing about this press may reach
      the device or the store: the microphone is not opened, no session is
      written down, and nothing is navigated to.
    */
    const { store, recorder } = await configure();
    const mounted = mount(
      createElement(Harness, { contexts: [OWN, SHARED], page: null, store }),
    );
    await settle();

    press("mic");

    expect(shown("meeting-destination-sheet")).toBe(true);
    expect(recorder.calls).toEqual([]);
    expect(meetings.getSnapshot().records).toEqual([]);
    expect(meetings.getSnapshot().live).toBeNull();
    expect(pushed).toEqual([]);
    mounted.unmount();
  });

  test("nothing is created in the bucket by asking the question", async () => {
    // `0-inbox` that does not exist yet is made by the write that puts a note
    // in it. A folder created by a question somebody cancelled is litter.
    const { store } = await configure();
    const mounted = mount(
      createElement(Harness, { contexts: [OWN, SHARED], page: null, store }),
    );
    await settle();

    press("mic");
    press("meeting-destination-cancel");
    await settle();

    expect(await store.keys()).toEqual([]);
    expect(shown("meeting-destination-sheet")).toBe(false);
    mounted.unmount();
  });

  test("the sheet says what happens to the audio, beside the control that starts it", async () => {
    const { store } = await configure();
    const mounted = mount(
      createElement(Harness, { contexts: [OWN, SHARED], page: null, store }),
    );
    await settle();
    press("mic");

    expect(text()).toContain("transcribed");
    expect(text()).toContain("discarded");
    expect(text()).toMatch(/never written to your bucket/i);
    expect(text()).toContain("one Markdown note");
    expect(shown("meeting-destination-start")).toBe(true);
    mounted.unmount();
  });
});

describe("the sheet is the disclosure, so it is never skipped", () => {
  test("the sheet opens even when the choice is remembered, because it is where the audio sentence is", async () => {
    /*
      THE consent property. A remembered choice is a preselection, never a
      permission: skipping the sheet would put recording one tap from any
      sentence about where the audio goes, which is the mode
      `docs/decisions/meetings.md` calls a bug rather than a mode.
    */
    const { store, recorder } = await configure();
    await rememberDestination(store, IN_A_PROJECT);

    const mounted = mount(
      createElement(Harness, {
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        store,
      }),
    );
    await settle();

    press("mic");

    expect(shown("meeting-destination-sheet")).toBe(true);
    expect(text()).toContain("discarded");
    expect(recorder.calls).toEqual([]);
    mounted.unmount();
  });

  test("a remembered choice preselects its row rather than the inbox", async () => {
    const { store } = await configure();
    await rememberDestination(store, IN_A_PROJECT);

    const mounted = mount(
      createElement(Harness, {
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        store,
      }),
    );
    await settle();
    press("mic");

    const row = document.body.querySelector('[data-testid="meeting-destination-row-1"]');
    expect(row?.getAttribute("aria-checked")).toBe("true");
    mounted.unmount();
  });
});

describe("what the sheet offers", () => {
  test("a shared page is drawn with the audience named on it", async () => {
    const { store } = await configure();
    const mounted = mount(
      createElement(Harness, {
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        store,
      }),
    );
    await settle();
    press("mic");

    expect(text()).toContain("@testagent1 / 0-inbox");
    expect(text()).toContain("Only you");
    expect(text()).toContain("@field-notes / 1-projects/portal");
    expect(text()).toContain("Visible to the team");
    mounted.unmount();
  });

  test("a refused row cannot be chosen by pressing it", async () => {
    const { store } = await configure();
    const mounted = mount(
      createElement(Harness, {
        contexts: [OWN, READ_ONLY],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        store,
      }),
    );
    await settle();
    press("mic");

    expect(shown("meeting-destination-row-1")).toBe(true);
    expect(text()).toContain("read this context but not write to it");

    press("meeting-destination-row-1");
    const inbox = document.body.querySelector('[data-testid="meeting-destination-row-0"]');
    expect(inbox?.getAttribute("aria-checked")).toBe("true");
    mounted.unmount();
  });

  test("somebody with no brain is offered their name, not a recording", async () => {
    const { store } = await configure();
    const claims: number[] = [];
    const mounted = mount(
      createElement(Harness, {
        contexts: [{ slug: "field-notes", kind: "shared", role: "editor" }],
        page: null,
        store,
        onClaimName: () => claims.push(1),
      }),
    );
    await settle();
    press("mic");

    expect(shown("meeting-destination-start")).toBe(false);
    expect(shown("meeting-destination-claim")).toBe(true);

    press("meeting-destination-claim");
    expect(claims).toEqual([1]);
    mounted.unmount();
  });
});

describe("a device that cannot record says so", () => {
  test("a device with no context yet refuses Start rather than throwing", async () => {
    /*
      Found in self-review. The controller is configured by an effect in another
      layout, so on a cold start — and permanently, if somebody mounts the key
      without `useMeetingsSetup` — `start()` throws. Inside the flow's
      fire-and-forget that is an unhandled rejection and a sheet that closes
      having done nothing, which is the silent failure this repo refuses. The
      sheet opens, and Start is dimmed with the reason.
    */
    await act(async () => {
      meetings.reset();
    });
    const store = memoryStore();
    const mounted = mount(
      createElement(Harness, { contexts: [OWN, SHARED], page: null, store }),
    );
    await settle();

    press("mic");
    expect(shown("meeting-destination-sheet")).toBe(true);
    expect(text()).toContain("nowhere to record into");

    press("meeting-destination-start");
    await settle();

    expect(meetings.getSnapshot().records).toEqual([]);
    expect(pushed).toEqual([]);
    mounted.unmount();
  });

  test("the refusal clears itself when the context lands underneath", async () => {
    // The ordinary cold start: the workspace list arrives a moment after
    // somebody has already opened the sheet. It must not stay refused until
    // they close and reopen it.
    await act(async () => {
      meetings.reset();
    });
    const store = memoryStore();
    const mounted = mount(
      createElement(Harness, { contexts: [OWN, SHARED], page: null, store }),
    );
    await settle();
    press("mic");
    expect(shown("meeting-destination-blocked")).toBe(true);

    await configure();
    await settle();

    expect(shown("meeting-destination-blocked")).toBe(false);
    mounted.unmount();
  });
});

describe("confirming is what starts the recording", () => {
  test("the meeting that results is the one the sheet described", async () => {
    const { store, recorder } = await configure();
    const mounted = mount(
      createElement(Harness, {
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal/kickoff.md", isNote: true },
        store,
      }),
    );
    await settle();

    press("mic");
    press("meeting-destination-row-1");
    press("meeting-destination-start");
    await settle();

    const live = meetings.getSnapshot().live;
    expect(live).not.toBeNull();
    expect(live!.destination).toEqual({
      kind: "currentPage",
      contextSlug: "field-notes",
      folder: "1-projects/portal",
      label: "1-projects/portal",
    });
    expect(recorder.calls).toContain("start");
    expect(pushed).toEqual([`/meetings/${live!.session.id}`]);
    expect(shown("meeting-destination-sheet")).toBe(false);
    mounted.unmount();
  });

  test("the default is what starts when nobody changes the selection", async () => {
    const { store } = await configure();
    const mounted = mount(
      createElement(Harness, {
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        store,
      }),
    );
    await settle();

    press("mic");
    press("meeting-destination-start");
    await settle();

    expect(meetings.getSnapshot().live!.destination).toEqual({
      kind: "personalInbox",
      contextSlug: "testagent1",
      folder: "0-inbox",
    });
    mounted.unmount();
  });

  test("a row that stops being on offer leaves no Start that does nothing", async () => {
    /*
      The selection was an **index** into a list the resolver recomputes on
      every render, from props that change while the sheet is open. Press the
      shared page's row, lose membership of that context a moment later — a
      revoked grant, a colleague removing you — and `offers[1]` is `undefined`
      while `selectedIndex` is still 1. `confirm` returned silently on that,
      which `useMeetingFlow`'s own rule forbids twice over: the key may not be a
      control that quietly does nothing, and the sheet must not draw a selected
      row it will not act on.

      So what is held is the resolved destination, not its position, and the
      resolver answers "which row is that now" with the same rule it uses for a
      remembered choice — including its fallback to the inbox for one that is no
      longer on offer. Start therefore starts the row that is drawn as selected,
      always.
    */
    const { store } = await configure();
    const inShared = {
      contexts: [OWN, SHARED],
      page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
      store,
    };
    const mounted = mount(createElement(Harness, inShared));
    await settle();

    press("mic");
    press("meeting-destination-row-1");
    expect(shown("meeting-destination-row-1")).toBe(true);

    // The grant goes away underneath the open sheet.
    mounted.rerender(createElement(Harness, { ...inShared, contexts: [OWN] }));
    await settle();

    expect(shown("meeting-destination-row-1")).toBe(false);
    press("meeting-destination-start");
    await settle();

    const [started] = meetings.getSnapshot().records;
    expect(started).toBeDefined();
    expect(started!.destination).toEqual({
      kind: "personalInbox",
      contextSlug: "testagent1",
      folder: "0-inbox",
    });
    mounted.unmount();
  });

  test("a row that goes read-only under the sheet falls back rather than refusing", async () => {
    // The same rule from the other side: a destination still on offer but no
    // longer takeable. `preselect` already declines to start on a control whose
    // only outcome is a refusal, and a press is held to that same rule.
    const { store } = await configure();
    const writable = {
      contexts: [OWN, SHARED],
      page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
      store,
    };
    const mounted = mount(createElement(Harness, writable));
    await settle();

    press("mic");
    press("meeting-destination-row-1");
    mounted.rerender(createElement(Harness, { ...writable, contexts: [OWN, READ_ONLY] }));
    await settle();

    press("meeting-destination-start");
    await settle();

    const [started] = meetings.getSnapshot().records;
    expect(started).toBeDefined();
    expect(started!.destination?.kind).toBe("personalInbox");
    mounted.unmount();
  });

  test("the choice is remembered for next time", async () => {
    const { store } = await configure();
    const mounted = mount(
      createElement(Harness, {
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        store,
      }),
    );
    await settle();

    press("mic");
    press("meeting-destination-row-1");
    press("meeting-destination-start");
    await settle();

    expect(await recallDestination(store)).toEqual(IN_A_PROJECT);
    mounted.unmount();
  });
});
