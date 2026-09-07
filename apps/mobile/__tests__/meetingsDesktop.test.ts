/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeDesktopBridge, type FakeDesktopBridge } from "@context/desktop-bridge/fake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE APP, RUNNING INSIDE THE DESKTOP SHELL.
 *
 * `docs/decisions/desktop.md`, step 3: the Expo app is the UI on macOS too, and
 * inside the shell the *shell* holds the microphone. So there is one new
 * question this suite exists to answer, and it has two halves that are equally
 * easy to get wrong:
 *
 *  - **In a shell, the shell records.** The bridge's `startCapture` is called,
 *    `MediaRecorder` is not touched, segments arrive over `onSegment`, and
 *    ending detaches — or the second meeting on that machine emits everything
 *    twice.
 *  - **Everywhere else, nothing changed at all.** A browser with no
 *    `window.desktop` still drives `MediaRecorder`; a phone still gets the
 *    `expo-audio` recorder. That half is not decoration: the shell is one
 *    surface out of four, and a regression here would be invisible to whoever
 *    is working on it.
 *
 * Between the two sits the rule the whole feature turns on — **nothing on
 * screen may claim a capability the shell did not report**. A build macOS has
 * not verified is refused a loopback tap at the same bridge version as one it
 * has, so the switch that offers to record the whole call is drawn from
 * `capabilities()` and from nothing else, and its absence is a sentence rather
 * than a disabled control.
 *
 * ## Why the fake bridge comes from the package
 *
 * `@context/desktop-bridge/fake` is the reference shell, and it is the one both
 * sides test against. A fake written here would be this app's guess at what the
 * Electron preload exposes, which is the drift the package was created to end —
 * and it would pass `getDesktopBridge()` only by accident, since that refuses
 * anything unfrozen, versioned wrong, or carrying a credential-shaped member.
 *
 * ## Sabotage record
 *
 * Broken deliberately, whole mobile suite run, reverted. Counts are failing
 * tests.
 *
 *   `ThisMachineCard` rendering with no bridge                               20
 *   the sheet drawing the switch whether or not it is offered                18
 *   `resolveRecorder` ignoring the bridge, so a shell gets the browser path   9
 *   `capabilitiesFrom` skipped, so a shell answering rubbish is believed      2
 *   detection reading `window.desktop` instead of `getDesktopBridge()`        1
 *   `desktopRecorder` not detaching on stop                                   1
 *   `startCapture` sending what the build can do rather than what was asked   1
 *   the mic-only report dropped when the shell grants less than was asked     1
 *   `resume` allowed after a stop                                             1
 *   the controller not passing the meeting id to `start`                      1
 *   the `ending` flag dropped, so every End reports a failure                 1
 *
 * Two of those numbers are large for a reason worth reading. **20** and **18**
 * are not this file being thorough: they are the rest of the suite falling over
 * because a component that must draw nothing drew something — the settings pane
 * and the destination sheet are rendered by a dozen other tests each. That is
 * the right direction to fail in, and it is also why the two one-line
 * assertions here matter: they name the defect, while the twenty tell you only
 * that something is broken.
 *
 * The **1**s are the opposite and are the ones to keep honest. Each is a
 * behaviour nothing else in this app looks at — no other test has a shell.
 */

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { resolveRecorder } =
  require("../features/meetings/capture/audio.web") as typeof import("../features/meetings/capture/audio.web");
const { DESKTOP_MESSAGES } =
  require("../features/meetings/capture/desktop") as typeof import("../features/meetings/capture/desktop");
const { fakeRecorder } =
  require("../features/meetings/capture/fake") as typeof import("../features/meetings/capture/fake");
const { setTranscriber, fakeTranscriber } =
  require("../features/meetings/capture/transcriber") as typeof import("../features/meetings/capture/transcriber");
const { MeetingsController } =
  require("../features/meetings/controller") as typeof import("../features/meetings/controller");
const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
const { fakeGateway } =
  require("../features/meetings/fakeGateway") as typeof import("../features/meetings/fakeGateway");
const { DestinationSheet, MIC_ONLY_SENTENCE } =
  require("../features/meetings/components/DestinationSheet") as typeof import("../features/meetings/components/DestinationSheet");
const { ThisMachineCard } =
  require("../features/meetings/components/ThisMachineCard") as typeof import("../features/meetings/components/ThisMachineCard");
const { describeMachine, machineTitle } =
  require("../features/meetings/thisMachine") as typeof import("../features/meetings/thisMachine");
/* eslint-enable @typescript-eslint/no-require-imports */

/* -------------------------------------------------------------------------- */
/*                                  the browser                               */
/* -------------------------------------------------------------------------- */

/**
 * Just enough browser for `browserCanRecord()` to say yes.
 *
 * Installed as real globals rather than mocked modules, the same way
 * `meetingsCaptureWeb.test.ts` does it: the capability probe reads globals, so
 * a test that stubbed a module would exercise nothing.
 */
let recorderInstances = 0;
let getUserMediaCalls = 0;

class FakeTrack extends EventTarget {
  readonly kind = "audio";
  stop(): void {}
}

function installBrowser(): void {
  class FakeMediaRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
      recorderInstances += 1;
    }
    static isTypeSupported(): boolean {
      return true;
    }
    start(): void {
      this.state = "recording";
    }
    stop(): void {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        getUserMediaCalls += 1;
        const tracks = [new FakeTrack()];
        return { getAudioTracks: () => tracks, getTracks: () => tracks };
      },
    },
  });
  if (typeof Blob.prototype.arrayBuffer !== "function") {
    Blob.prototype.arrayBuffer = async function arrayBuffer() {
      return new ArrayBuffer(0);
    };
  }
}

/** Put a shell on the page, the way a preload would. */
function installShell(fake: FakeDesktopBridge): void {
  (globalThis as Record<string, unknown>).desktop = fake.bridge;
}

function removeShell(): void {
  delete (globalThis as Record<string, unknown>).desktop;
}

function mount(element: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    container: host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const has = (container: HTMLElement, testId: string): boolean =>
  container.querySelector(`[data-testid="${testId}"]`) !== null;

beforeEach(() => {
  document.body.replaceChildren();
  recorderInstances = 0;
  getUserMediaCalls = 0;
  installBrowser();
  removeShell();
  setTranscriber(fakeTranscriber());
});

afterEach(() => {
  removeShell();
  setTranscriber(null);
});

/* -------------------------------------------------------------------------- */

describe("a browser with no shell is unchanged", () => {
  test("the web build still drives MediaRecorder", async () => {
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(true);
    expect(recorder.capability.systemAudio).toBe(false);

    await recorder.start({ sessionId: "mtg_web", systemAudio: false });
    expect(getUserMediaCalls).toBe(1);
    expect(recorderInstances).toBe(1);
    await recorder.stop();
  });

  /**
   * The honest sentence a browser has always made, now in the one place
   * somebody reads before pressing Record rather than only in a file header.
   */
  test("...and says the far side of a call is not in the recording", () => {
    expect(MIC_ONLY_SENTENCE).toMatch(/far side of a call/i);
  });

  test("a phone asked of the web module is still a phone", async () => {
    const recorder = await resolveRecorder("ios");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.systemAudio).toBe(false);
  });

  /**
   * Detection is `getDesktopBridge()`, not `"desktop" in window`.
   *
   * An object a page put there itself is not a shell: it is not frozen, and the
   * validator refuses it. Without this the browser path would be replaced by a
   * recorder wired to whatever a compromised page decided to expose — and the
   * person would be told they were recording.
   */
  test("an object pretending to be a shell gets the browser path", async () => {
    (globalThis as Record<string, unknown>).desktop = {
      version: 1,
      capabilities: async () => ({ mic: true, systemAudio: true }),
      startCapture: async () => ({}),
    };
    const recorder = await resolveRecorder("web");
    await recorder.start({ sessionId: "mtg_web", systemAudio: false });
    expect(getUserMediaCalls).toBe(1);
    await recorder.stop();
  });
});

describe("inside the shell, the shell records", () => {
  test("start goes over the bridge and never touches the microphone", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);

    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(true);
    expect(recorder.capability.transcribesAt).toBe("cloud");

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });

    expect(shell.calls).toContain("startCapture");
    expect(shell.lastStart?.sessionId).toBe("mtg_desktop");
    expect(shell.lastStart?.mic).toBe(true);
    // The whole claim: no getUserMedia, no MediaRecorder, no stream on the page.
    expect(getUserMediaCalls).toBe(0);
    expect(recorderInstances).toBe(0);
  });

  test("segments the shell produces reach the app", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const heard: string[] = [];
    recorder.onSegment((segment) => heard.push(segment.text));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    shell.emitSegment({
      id: "seg-1",
      startMs: 0,
      endMs: 2_000,
      text: "we should ship it",
      speaker: null,
      channel: "mic",
      confidence: null,
    });

    expect(heard).toEqual(["we should ship it"]);
  });

  /**
   * Ending a meeting detaches, and this is why every bridge subscription
   * returns its own unsubscribe: the controller keeps one recorder for many
   * meetings, so a subscription left attached would deliver the next meeting's
   * segments through the previous meeting's listeners as well.
   */
  test("ending detaches from the shell", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const heard: string[] = [];
    recorder.onSegment((segment) => heard.push(segment.text));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    await recorder.stop();
    expect(shell.calls).toContain("stopCapture");
    expect(shell.listenerCount()).toBe(0);

    shell.emitSegment({
      id: "seg-2",
      startMs: 0,
      endMs: 1_000,
      text: "after the end",
      speaker: null,
      channel: "mic",
      confidence: null,
    });
    expect(heard).toEqual([]);
  });

  /**
   * Ending a meeting is not a failure, and must not be reported as one.
   *
   * The shell pushes a final `{ state: "stopped", capturing: false }` on its
   * way out, which is byte-identical to the shell giving up on its own. Read
   * without knowing who asked, every single End produced "The Context app
   * stopped recording" — the kind of noise that teaches somebody to ignore the
   * one time it is true. The stop is not awaited before the event so that the
   * event lands where a real one does: inside the stop, before the recorder has
   * detached.
   */
  test("a normal End reports nothing", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    const stopping = recorder.stop();
    shell.emitCaptureState({ state: "stopped", capturing: false, fault: null });
    await stopping;

    expect(errors).toEqual([]);
  });

  /** ...and a shell that gives up on its own still says so. */
  test("a shell that stops by itself is reported", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    shell.emitCaptureState({ state: "stopped", capturing: false, fault: null });

    expect(errors).toEqual([DESKTOP_MESSAGES.lost]);
    await recorder.stop();
  });

  /** The rule the lifted state machine holds, once, for five recorders. */
  test("a meeting that ended does not reopen the microphone", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    await recorder.stop();
    await recorder.resume();

    expect(shell.calls).not.toContain("resumeCapture");
    expect(recorder.state).toBe("stopped");
  });

  test("a refused start is reported rather than thrown away", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true },
      refuseStart: "Microphone access is off for Context in System Settings.",
    });
    installShell(shell);
    const recorder = await resolveRecorder("web");

    await expect(
      recorder.start({ sessionId: "mtg_desktop", systemAudio: false }),
    ).rejects.toThrow(/System Settings/);
  });
});

describe("system audio is offered only where it exists", () => {
  test("a shell without it reports it, and the capability says so", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.systemAudio).toBe(false);
  });

  test("a shell with it asks for it, and only when the person did", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true, systemAudio: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.systemAudio).toBe(true);

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    expect(shell.lastStart?.systemAudio).toBe(false);

    await recorder.stop();
    await recorder.start({ sessionId: "mtg_desktop_2", systemAudio: true });
    expect(shell.lastStart?.systemAudio).toBe(true);
  });

  /**
   * Asked for the whole call, given half of it — an unsigned build, or one
   * macOS has stopped trusting. The recording is fine and the *claim* would not
   * have been, so it is reported rather than rendered silently.
   */
  test("a shell that grants less than was asked says so", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true, systemAudio: true },
      started: { systemAudio: false },
    });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: true });
    expect(errors).toContain(DESKTOP_MESSAGES.micOnly);
  });

  /**
   * A shell that can hear nothing is a typed session with a sentence about
   * *this machine* — not about "this browser", which would send somebody to the
   * wrong settings screen entirely.
   */
  test("a shell that can hear nothing is honest about it", async () => {
    const shell = fakeDesktopBridge();
    installShell(shell);
    const recorder = await resolveRecorder("web");

    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.transcribesAt).toBe("nowhere");
    expect(recorder.capability.unavailableReason).toBe(DESKTOP_MESSAGES.noAudio);

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    expect(shell.calls).not.toContain("startCapture");
    // The clock still runs and the notepad still works: a refused microphone
    // must not cost somebody their notes.
    expect(recorder.state).toBe("recording");
  });

  /*
    These two replace the probe rather than configuring the fake, so they build
    a bridge of their own: the reference fake is **frozen**, exactly as the
    preload's object is, and assigning over one of its methods does nothing at
    all. The first version of both tests did that and passed while asserting
    nothing.
  */
  const shellAnswering = (capabilities: () => Promise<unknown>) =>
    Object.freeze({ ...fakeDesktopBridge().bridge, capabilities }) as never;

  /** A shell answering rubbish is a shell that can do nothing. */
  test("a capability that is not `true` is not a capability", async () => {
    (globalThis as Record<string, unknown>).desktop = shellAnswering(async () => ({
      mic: "yes",
      systemAudio: 1,
    }));
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.systemAudio).toBe(false);
  });

  test("a shell that will not answer at all is not believed either", async () => {
    (globalThis as Record<string, unknown>).desktop = shellAnswering(async () => {
      throw new Error("no channel");
    });
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(false);
    /*
      ...and the sentence is still the shell's rather than the browser's. This
      page is inside a shell; telling somebody their browser cannot record would
      send them to the wrong settings screen entirely.
    */
    expect(recorder.capability.unavailableReason).toBe(DESKTOP_MESSAGES.noAudio);
  });
});

describe("the sheet offers what the machine can do, and nothing else", () => {
  const choice = {
    kind: "choose" as const,
    selectedIndex: 0,
    offers: [
      {
        destination: { kind: "personalInbox" as const, contextSlug: "@you", folder: "0-inbox" },
        audience: "Only you",
        tone: "quiet" as const,
        refusal: null,
      },
    ],
  };

  function sheet(systemAudio: { on: boolean; onToggle: (on: boolean) => void } | null) {
    return createElement(DestinationSheet, {
      choice: choice as never,
      selectedIndex: 0,
      onSelect: () => {},
      onStart: () => {},
      onCancel: () => {},
      systemAudio,
    });
  }

  /*
    Read off `document.body` rather than off the container: the sheet is a
    `Modal`, and react-native-web renders one into a portal. Same reason
    `meetingsFlow.test.ts` gives for doing it that way.
  */
  test("no capability, no switch — a sentence instead", () => {
    const mounted = mount(sheet(null));
    expect(has(document.body, "meeting-system-audio")).toBe(false);
    expect(has(document.body, "meeting-mic-only")).toBe(true);
    expect(document.body.textContent).toContain("far side of a call");
    mounted.unmount();
  });

  test("a machine that can hear the call is offered the switch", () => {
    const mounted = mount(sheet({ on: true, onToggle: () => {} }));
    expect(has(document.body, "meeting-system-audio")).toBe(true);
    expect(document.body.textContent).toContain("Record the whole call");
    mounted.unmount();
  });
});

describe("the meeting's own id goes to the shell", () => {
  /**
   * The desktop shell queues writes in another process, keyed by session. A
   * capture started under any other name would be a second meeting in
   * somebody's bucket that nothing on this device ever reconciles.
   */
  test("the controller hands the recorder the id it minted", async () => {
    const recorder = fakeRecorder({ systemAudio: true });
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder,
      device: { platform: "web" },
    });

    const id = await controller.start({ title: "Standup", systemAudio: true });

    expect(recorder.startedWith?.sessionId).toBe(id);
    expect(recorder.startedWith?.systemAudio).toBe(true);
  });

  test("...and where nobody was asked, the build's own answer is used", async () => {
    const recorder = fakeRecorder();
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder,
      device: { platform: "web" },
    });

    await controller.start({ title: "Standup" });
    expect(recorder.startedWith?.systemAudio).toBe(false);
  });
});

describe("this machine, in settings", () => {
  test("a machine with no grant is offered one, and told what it gets", () => {
    const view = describeMachine({
      state: "disconnected",
      gateway: null,
      encrypted: true,
      connecting: false,
      error: null,
    });
    expect(view.action).toBe("connect");
    expect(view.pill).toBe("Not connected");
  });

  /**
   * `revoked` is not `disconnected`, and this is the reason it is worth a
   * separate word: only one of them has finished meetings waiting on a button.
   */
  test("a revoked machine says the queue is waiting", () => {
    const view = describeMachine({
      state: "revoked",
      gateway: "https://gateway.invalid",
      encrypted: true,
      connecting: false,
      error: null,
    });
    expect(view.tone).toBe("warn");
    expect(view.sentence).toMatch(/queued/i);
    expect(view.action).toBe("connect");
  });

  test("a connected machine says where meetings go, and never how", () => {
    const view = describeMachine({
      state: "connected",
      gateway: "https://gateway.invalid/mcp",
      encrypted: true,
      connecting: false,
      error: null,
    });
    expect(view.sentence).toContain("https://gateway.invalid/mcp");
    expect(view.action).toBe("disconnect");
    expect(JSON.stringify(view)).not.toMatch(/token|secret|credential/i);
  });

  test("a machine with no encrypted storage is told so before it connects", () => {
    const view = describeMachine({
      state: "disconnected",
      gateway: null,
      encrypted: false,
      connecting: false,
      error: null,
    });
    expect(view.notice).toMatch(/encrypted storage/i);
  });

  test("the heading names the kind of machine, never the machine", () => {
    expect(machineTitle({ app: "Context", version: "1.0.0", platform: "macos" })).toBe(
      "Context on this Mac",
    );
    expect(machineTitle(null)).toBe("This machine");
  });

  test("the card is not drawn in a browser", () => {
    const mounted = mount(createElement(ThisMachineCard));
    expect(mounted.container.textContent).toBe("");
    mounted.unmount();
  });

  test("...and in a shell it draws the connection, from the bridge", async () => {
    const shell = fakeDesktopBridge({
      connection: {
        state: "connected",
        gateway: "https://gateway.invalid",
        encrypted: true,
        connecting: false,
        error: null,
      },
    });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await act(async () => {
      await Promise.resolve();
    });

    expect(has(mounted.container, "this-machine-title")).toBe(true);
    expect(mounted.container.textContent).toContain("https://gateway.invalid");

    const button = mounted.container.querySelector('[data-testid="this-machine-disconnect"]');
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(shell.calls).toContain("connection.disconnect");

    mounted.unmount();
    // Unmounting detaches: a settings pane is opened and closed all day, and a
    // handler that could not be detached is a leak per visit.
    expect(shell.listenerCount()).toBe(0);
  });
});
