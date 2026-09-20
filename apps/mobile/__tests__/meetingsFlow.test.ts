/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Pressing New meeting, and what it is allowed to do without asking.
 *
 * ## The property this file used to hold, and what replaced it
 *
 * It held *the key asks, it does not record*: a sheet in front of every
 * recording, because `docs/decisions/meetings.md` refuses a control that opens
 * the microphone with no disclosure — "a detector that silently started
 * recording would be the same product with the indicator removed".
 *
 * The owner removed the question, in those words: *"all meetings from now on
 * should go into 0-inbox/meetings, no need to ask people it will just confuse
 * them"*. What the decision actually protects is the **indicator**, and that is
 * now where the disclosure lives — the panel opens on the running meeting with
 * a red mark, a clock and the path the note is going to, for the length of the
 * run. So the tests here changed shape rather than being deleted: the press
 * records, and what it records, where it lands and what it says when it cannot
 * are each pinned.
 *
 * Two properties survived the change untouched, and they are the ones worth
 * naming:
 *
 *  - **A meeting lands in the person's own inbox, never the shared context
 *    they are standing in.** It was a privacy rule with a sheet in front of it;
 *    with no sheet there is nothing between the press and the bucket, so it
 *    matters more here rather than less.
 *  - **A press that cannot record says so.** A control that quietly does
 *    nothing is the defect this feature has closed at every layer.
 *
 * ## Sabotage record
 *
 * Each applied, suite run, named test failed, reverted.
 *
 *  1. `automaticDestination` keyed off the context the person is standing in.
 *     → `a meeting recorded in a shared workspace still lands in your own
 *     inbox` fails. (The pure half is `meetingsDestination.test.ts`'s.)
 *  2. The `live !== null` guard dropped from `startMeetingFlow`.
 *     → `pressing it again while one is running shows that one rather than
 *     starting a second` fails, with two records for one conversation.
 *  3. The `starting` ref dropped.
 *     → `two presses in the same moment record one meeting` fails.
 *  4. `snapshot.status !== "ready"` no longer refuses, so the press falls
 *     through to `controller.start`.
 *     → `a device with no context yet says so rather than throwing` fails.
 *  5. The `claimName` arm starts a meeting anyway.
 *     → `somebody who owns no workspace is offered their name, not a
 *     recording` fails.
 *  6. `show` always pushes the route, ignoring `onStarted`.
 *     → `a surface that can show a meeting in place is not navigated away
 *     from` fails.
 *  7. `recallSystemAudio`'s stored answer ignored in favour of the default.
 *     → `the machine's own audio follows the setting, not a question` fails.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const pushed: string[] = [];
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href), replace: () => {}, back: () => {} }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { useMeetingFlow, NOT_READY_REFUSAL, NO_WORKSPACE_REFUSAL, START_FAILED } =
  require("../features/meetings/useMeetingFlow") as typeof import("../features/meetings/useMeetingFlow");
const { meetings } =
  require("../features/meetings/controller") as typeof import("../features/meetings/controller");
const { fakeGateway } =
  require("../features/meetings/fakeGateway") as typeof import("../features/meetings/fakeGateway");
const { fakeRecorder } =
  require("../features/meetings/capture/fake") as typeof import("../features/meetings/capture/fake");
const { INBOX_FOLDER } =
  require("../features/meetings/destination") as typeof import("../features/meetings/destination");
const { rememberMachineAudio } =
  require("../features/meetings/machineAudio") as typeof import("../features/meetings/machineAudio");
const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
/* eslint-enable @typescript-eslint/no-require-imports */

type Store = ReturnType<typeof memoryStore>;
type Recorder = ReturnType<typeof fakeRecorder>;

const OWN = { slug: "testagent1", kind: "personal", role: "owner" };
const SHARED = { slug: "field-notes", kind: "shared", role: "editor" };

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
    rerender: (next: ReactElement) => {
      act(() => root.render(next));
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** The control, wherever it lives — the console's + menu, or the phone's key. */
function Harness(props: Parameters<typeof useMeetingFlow>[0]): ReactElement {
  const flow = useMeetingFlow(props);
  return createElement(
    "div",
    null,
    createElement("button", { "data-testid": "new-meeting", onClick: flow.startMeetingFlow }, "+"),
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

async function configure(
  capability?: Partial<Recorder["capability"]>,
): Promise<{ store: Store; recorder: Recorder }> {
  const store = memoryStore();
  const recorder = fakeRecorder(capability);
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
    React Native Web's `Modal` portals out of the host element, so a dialog is
    read off `document.body` rather than off a container — which means a test
    that fails before it unmounts leaves a live harness behind, and the next
    press finds *its* control.
  */
  document.body.replaceChildren();
});

/* -------------------------------------------------------------------------- */

describe("pressing it records, and asks nothing", () => {
  test("one press opens the microphone, with no sheet in the way", async () => {
    const { store, recorder } = await configure();
    const shown_: string[] = [];
    const mounted = mount(
      createElement(Harness, { contexts: [OWN], store, onStarted: (id) => shown_.push(id) }),
    );
    await settle();

    press("new-meeting");
    await settle();

    const live = meetings.getSnapshot().live;
    expect(live).not.toBeNull();
    expect(live!.session.state).toBe("recording");
    expect(recorder.calls).toContain("start");
    expect(shown_).toEqual([live!.session.id]);
    expect(shown("meeting-refusal")).toBe(false);
    mounted.unmount();
  });

  test("a meeting recorded in a shared workspace still lands in your own inbox", async () => {
    /*
      The privacy rule, with nothing in front of it any more. A transcript
      dropped into a folder colleagues watch, before the person who recorded it
      has read a word of it, is the failure this whole module exists to prevent.
    */
    const { store } = await configure();
    const mounted = mount(createElement(Harness, { contexts: [SHARED, OWN], store }));
    await settle();

    press("new-meeting");
    await settle();

    expect(meetings.getSnapshot().live!.destination).toEqual({
      kind: "personalInbox",
      contextSlug: "testagent1",
      folder: INBOX_FOLDER,
    });
    mounted.unmount();
  });

  test("two presses in the same moment record one meeting", async () => {
    const { store } = await configure();
    const mounted = mount(createElement(Harness, { contexts: [OWN], store }));
    await settle();

    press("new-meeting");
    press("new-meeting");
    await settle();

    expect(meetings.getSnapshot().records).toHaveLength(1);
    mounted.unmount();
  });

  test("pressing it again while one is running shows that one rather than starting a second", async () => {
    const { store } = await configure();
    const shown_: string[] = [];
    const mounted = mount(
      createElement(Harness, { contexts: [OWN], store, onStarted: (id) => shown_.push(id) }),
    );
    await settle();

    press("new-meeting");
    await settle();
    const first = meetings.getSnapshot().live!.session.id;

    press("new-meeting");
    await settle();

    expect(meetings.getSnapshot().records).toHaveLength(1);
    expect(shown_).toEqual([first, first]);
    mounted.unmount();
  });
});

describe("where the meeting shows up is the caller's business", () => {
  test("a surface that can show a meeting in place is not navigated away from", async () => {
    // The console. The note stays open and the panel takes the meeting.
    const { store } = await configure();
    const mounted = mount(
      createElement(Harness, { contexts: [OWN], store, onStarted: () => {} }),
    );
    await settle();

    press("new-meeting");
    await settle();

    expect(pushed).toEqual([]);
    mounted.unmount();
  });

  test("a surface with nowhere to put one gets the meeting's own screen", async () => {
    // The phone: `regionsFor` gives compact no panel at all, so the route is
    // still where a running meeting is watched and stopped.
    const { store } = await configure();
    const mounted = mount(createElement(Harness, { contexts: [OWN], store }));
    await settle();

    press("new-meeting");
    await settle();

    const live = meetings.getSnapshot().live;
    expect(pushed).toEqual([`/meetings/${live!.session.id}`]);
    mounted.unmount();
  });
});

describe("a press that cannot record says so", () => {
  test("a device with no context yet says so rather than throwing", async () => {
    meetings.reset();
    const store = memoryStore();
    const mounted = mount(createElement(Harness, { contexts: [OWN], store }));
    await settle();

    press("new-meeting");
    await settle();

    expect(shown("meeting-refusal")).toBe(true);
    expect(text()).toContain(NOT_READY_REFUSAL);
    expect(meetings.getSnapshot().records).toHaveLength(0);
    mounted.unmount();
  });

  test("the refusal clears when the context lands underneath", async () => {
    meetings.reset();
    const store = memoryStore();
    const mounted = mount(createElement(Harness, { contexts: [OWN], store }));
    await settle();

    press("new-meeting");
    await settle();
    expect(shown("meeting-refusal")).toBe(true);

    await act(async () => {
      await meetings.configure({
        workspaceId: "ws-1",
        store,
        gateway: fakeGateway(),
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });

    press("meeting-refusal-close");
    press("new-meeting");
    await settle();

    expect(meetings.getSnapshot().live).not.toBeNull();
    mounted.unmount();
  });

  test("a microphone that will not open says so, rather than nothing at all", async () => {
    /*
      `controller.start` rejects for a recorder that cannot open a device. It
      used to be an unhandled rejection behind a `void (async () => …)`, which
      is the press that does nothing twice over — the state `RecordingBar`'s
      End was rewritten to close: *"I don't know if it succeeded, if it failed.
      Just nothing at all."*
    */
    const { store } = await configure();
    const controller = {
      subscribe: meetings.subscribe,
      getSnapshot: meetings.getSnapshot,
      start: () => Promise.reject(new Error("no device")),
    } as unknown as Parameters<typeof useMeetingFlow>[0]["controller"];

    const mounted = mount(createElement(Harness, { contexts: [OWN], store, controller }));
    await settle();

    press("new-meeting");
    await settle();

    expect(text()).toContain(START_FAILED);
    mounted.unmount();
  });

  test("somebody who owns no workspace is offered their name, not a recording", async () => {
    const { store } = await configure();
    const claims: number[] = [];
    const mounted = mount(
      createElement(Harness, {
        contexts: [SHARED],
        store,
        onClaimName: () => claims.push(1),
      }),
    );
    await settle();

    press("new-meeting");
    await settle();

    expect(text()).toContain(NO_WORKSPACE_REFUSAL);
    expect(meetings.getSnapshot().records).toHaveLength(0);

    press("meeting-refusal-claim");
    expect(claims).toHaveLength(1);
    mounted.unmount();
  });
});

describe("the machine's own audio is a setting now, not a question", () => {
  async function startWith(
    capability: Partial<Recorder["capability"]>,
    chosen: boolean | null = null,
  ): Promise<Recorder> {
    const { store, recorder } = await configure(capability);
    if (chosen !== null) await rememberMachineAudio(store, chosen);
    const mounted = mount(createElement(Harness, { contexts: [OWN], store }));
    await settle();
    press("new-meeting");
    await settle();
    mounted.unmount();
    return recorder;
  }

  test("the shell's silent tap is on, because it costs nothing to take", async () => {
    const recorder = await startWith({ systemAudio: true, systemAudioNeedsPicker: false });
    expect(recorder.startedWith?.systemAudio).toBe(true);
  });

  test("the browser's picker is off, because it costs a prompt every meeting", async () => {
    const recorder = await startWith({ systemAudio: true, systemAudioNeedsPicker: true });
    expect(recorder.startedWith?.systemAudio).toBe(false);
  });

  test("the machine's own audio follows the setting, not a question", async () => {
    /*
      The capability the sheet's switch used to carry. In a browser it costs a
      source picker, so it cannot be the default — and with the sheet gone
      there would be no way to turn it on at all if the settings pane did not
      hold the answer.
    */
    const recorder = await startWith({ systemAudio: true, systemAudioNeedsPicker: true }, true);
    expect(recorder.startedWith?.systemAudio).toBe(true);
  });

  test("a build that cannot take it sends no answer at all", async () => {
    const recorder = await startWith({ systemAudio: false, systemAudioNeedsPicker: false }, true);
    /*
      Not the stored `true`. The controller's own fallback decides for a build
      that cannot do this, and sending a setting it would have to ignore is the
      app inventing an answer on somebody's behalf.
    */
    expect(recorder.startedWith?.systemAudio).toBe(false);
  });
});
