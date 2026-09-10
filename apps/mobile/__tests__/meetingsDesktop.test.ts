/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
 * And a third, from the half step 3 deferred: **in a shell, the shell also
 * writes.** `desktopGateway.ts` hands each of the meetings protocol's four
 * writes to the machine's own queue, so a meeting on a Mac takes one credential
 * rather than two and the outbox that drains with no window open is on the
 * path. The check `docs/decisions/desktop.md` names is *the page does not write
 * directly in desktop mode*, and it is the one below that asserts the page's
 * own writer was never called.
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
 *   the platform half of detection dropped, so a phone with a shell uses it   1
 *   a native-resolved capture module importing `./desktop`                    1
 *   `meetingsWriterFor` returning the fallback inside a shell                 3
 *   `desktopGateway.finalize` acking a queued write as written                1
 *   the destination dropped instead of refused when the slug is unroutable    1
 *   `createDesktopGateway` sending the shell's bodies, not the protocol's      1
 *
 * The last two were added by review, because the first of them measured **0**
 * against the suite as written: *"a phone asked of the web module is still a
 * phone"* runs with no shell on the page, so deleting `platform !== "web"` from
 * `resolveRecorder` changed nothing it could see. The rule is
 * `Platform.OS === "web" && getDesktopBridge() !== null` and both halves are
 * load-bearing — `window.desktop` is a web-only concept by construction — so
 * the phone case now runs with a real, valid shell installed, and the import
 * boundary that keeps `capture/desktop.ts` out of the iOS bundle is read off
 * the source, which is the only place a bundling rule is visible.
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

/**
 * The control plane, as `ThisMachineCard` reaches it.
 *
 * The card now answers the machine approval the shell parks, which means one
 * action and one auth reading. Both are staged rather than provided, because
 * what is being checked is a *decision* — whether this page mints a credential,
 * and what it tells the shell — and a real Convex client would make that a
 * question about a network.
 */
let mockAuthState = { isLoading: false, isAuthenticated: true };
let mockMintCalls: { requestId: string }[] = [];
let mockMintAnswer: (args: { requestId: string }) => Promise<unknown> = async () => ({
  redirectTo: "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
  workspaceSlug: "seyi",
});

jest.mock("convex/react", () => ({
  useConvexAuth: () => mockAuthState,
  useAction: () => (args: { requestId: string }) => {
    mockMintCalls.push(args);
    return mockMintAnswer(args);
  },
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
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
const { createDesktopGateway, meetingsWriterFor, DESKTOP_WRITE_SENTENCES } =
  require("../features/meetings/desktopGateway") as typeof import("../features/meetings/desktopGateway");
const { MeetingGatewayError } =
  require("../features/meetings/gateway") as typeof import("../features/meetings/gateway");
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
  mockAuthState = { isLoading: false, isAuthenticated: true };
  mockMintCalls = [];
  mockMintAnswer = async () => ({
    redirectTo: "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
    workspaceSlug: "seyi",
  });
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
   * ...and it stays a phone with a shell sitting right there.
   *
   * The detection rule is `Platform.OS === "web" && getDesktopBridge() !== null`
   * and the first half is not decoration: `window.desktop` is a web-only
   * concept by construction — on a phone the Expo binary *is* the native
   * surface — so a bridge that somehow existed there must change nothing. The
   * check above passes with no shell on the page at all, which means it would
   * go on passing if the platform half of the rule were deleted. This one puts
   * a real, valid shell in front of it first, and nothing about the answer
   * moves.
   */
  test("...and a shell on the page does not turn a phone into a desktop", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true, systemAudio: true } });
    installShell(shell);

    const recorder = await resolveRecorder("ios");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.systemAudio).toBe(false);

    await recorder.start({ sessionId: "mtg_phone", systemAudio: true });
    expect(shell.calls).toEqual([]);
  });

  /**
   * And the native half of the split cannot reach the shell recorder at all.
   *
   * Read off the source rather than driven, because what is being asserted is
   * about a bundle Metro builds rather than about a call: `capture/desktop.ts`
   * is reached only through `audio.web.ts`, which Metro hands to the web build
   * and never to a phone. A `./desktop` import in any other capture module puts
   * an Electron-shaped surface in the iOS bundle to describe a global that
   * cannot exist there — and no runtime check inside this app would notice,
   * because on a phone the answer would simply be `null` forever.
   */
  test("only the web half of the split imports the shell recorder", () => {
    const dir = join(__dirname, "..", "features", "meetings", "capture");
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && name !== "audio.web.ts" && name !== "desktop.ts")
      .filter((name) => /from\s+"\.\/desktop"/.test(readFileSync(join(dir, name), "utf8")));
    expect(offenders).toEqual([]);
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
    shell.emitCaptureState({ state: "stopped", capturing: false, fault: null, notice: null });
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
    shell.emitCaptureState({ state: "stopped", capturing: false, fault: null, notice: null });

    expect(errors).toEqual([DESKTOP_MESSAGES.lost]);
    await recorder.stop();
  });

  /**
   * A MEETING THAT STOPS BEING TRANSCRIBED SAYS SO ON THE SCREEN.
   *
   * The sentence exists — `CAPTURE_NOTICES.refused`, "this meeting is not being
   * transcribed" — and the shell has always raised it. It had nowhere to go:
   * `CaptureStateUpdate` was `{state, capturing, fault}` and a notice is not a
   * fault, so the shell said it to its own tray and the console drew a recording
   * that looked perfectly healthy. That is why a defect which killed the
   * transcript of *every* desktop recording stayed invisible for a day — the
   * only place it surfaced was an empty transcript, afterwards.
   *
   * Once, not per push: the shell pushes this on every move of its recorder,
   * which is every segment.
   */
  test("a notice the shell raises mid-meeting reaches the screen, once", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    const refused = "This meeting is not being transcribed — the gateway would not accept the audio.";
    shell.emitCaptureState({ state: "recording", capturing: true, fault: null, notice: refused });
    shell.emitCaptureState({ state: "recording", capturing: true, fault: null, notice: refused });

    expect(errors).toEqual([refused]);
    await recorder.stop();
  });

  /**
   * The rule the lifted state machine holds — for the three recorders that
   * answer to it. The two that hold a real device still hold it by hand, each
   * with its own test of the same name; `packages/meetings/src/recorder.js`
   * says why and names converting them as the next step.
   */
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

describe("the shell records it, and the shell writes it", () => {
  /**
   * ONE MEETING IS ONE CREDENTIAL, AND ON A MAC IT IS THE MACHINE'S.
   *
   * Step 3 replaced the *recorder* and nothing else, so a meeting in the shell
   * took two: the shell's machine grant for the audio it captured and
   * transcribed, and the **page's** control-plane session for the note. What
   * that cost is what `convexGateway.ts` already lists — no enhancement pass, no
   * `.meetings/` session record, no `list_meetings` — plus one thing that was
   * only true here: the shell's window-less outbox was not on the path, so a
   * meeting was written by the page that happened to be open rather than by the
   * queue that survives it.
   *
   * `desktopGateway.ts` is that half. The page composes and the **shell**
   * writes, through the same outbox the tray-only recording uses, so a meeting
   * recorded with the window closed and one recorded from the console take the
   * same path with the same credential.
   *
   * The test the decision names is `the page does not write directly in desktop
   * mode`: it fails the moment `useMeetingsSetup` stops swapping the writer, or
   * a screen starts calling the control-plane one behind its back.
   */
  const segment = (id: string, text: string) => ({
    id,
    startMs: 0,
    endMs: 2_000,
    text,
    speaker: null,
    channel: "mic" as const,
    confidence: null,
  });

  /** A shell whose queue drains: every finalize comes back with a note path. */
  function writingShell(notePath = "5-meetings/2026-09-07-standup.md") {
    return fakeDesktopBridge({
      capabilities: { mic: true },
      write: (write) =>
        write.kind === "finalize"
          ? { sessionId: write.sessionId, queued: false, notePath, rejected: null }
          : { sessionId: write.sessionId, queued: true, notePath: null, rejected: null },
    });
  }

  test("A MEETING RECORDED FROM THE CONSOLE IS WRITTEN BY THE MACHINE'S OWN GRANT", async () => {
    const shell = writingShell();
    installShell(shell);

    const recorder = await resolveRecorder("web");
    const page = fakeGateway();
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      // The one line `useMeetingsSetup` runs, with the browser's writer as the
      // fallback it would have used outside a shell.
      gateway: meetingsWriterFor(page),
      recorder,
      device: { platform: "web" },
    });

    const id = await controller.start({ title: "Standup" });
    shell.emitSegment(segment("seg-1", "we should ship it"));
    await controller.end();

    // The shell held the input, and this page never asked for one.
    expect(shell.lastStart?.sessionId).toBe(id);
    expect(shell.calls).toContain("stopCapture");
    expect(getUserMediaCalls).toBe(0);
    expect(recorderInstances).toBe(0);

    // THE PAGE DID NOT WRITE. Every write went to the machine's queue.
    expect(page.calls).toEqual([]);
    expect(page.notesWritten()).toBe(0);

    const kinds = shell.writes.map((write) => write.kind);
    expect(kinds).toContain("session");
    expect(kinds).toContain("segments");
    expect(kinds).toContain("finalize");
    expect(shell.writes.every((write) => write.sessionId === id)).toBe(true);
    // ...and the transcript the shell produced went back to the shell to be
    // filed, under the id the page minted, so one meeting is one note.
    const segments = shell.writes.find((write) => write.kind === "segments");
    expect((segments?.body.segments as { text: string }[])[0].text).toBe("we should ship it");
  });

  /**
   * THE EMPTY-NOTES RACE, AS CLOSE TO END-TO-END AS THIS SIDE OF THE IPC GOES.
   *
   * This is what `BeginInput.queueWrites: false` exists to prevent, seen from
   * the page: with two writers on one meeting, the shell's `end()` queues an
   * **empty** `notes` and a finalize and drains them, and the gateway writes the
   * note before the person's typed Markdown has left this process. The note
   * somebody opens afterwards has the transcript and none of their notes in it.
   *
   * The shell half is checked in `apps/desktop`'s controller suite — a
   * console-started meeting queues nothing there. This is the other half: one
   * meeting, one session id, and the writes that reach the machine carry the
   * transcript *and* the typed notes, with exactly one finalize behind them.
   */
  test("ONE MEETING, ONE SESSION, AND BOTH THE TRANSCRIPT AND THE TYPED NOTES REACH IT", async () => {
    const shell = writingShell();
    installShell(shell);

    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: meetingsWriterFor(fakeGateway()),
      recorder: await resolveRecorder("web"),
      device: { platform: "web" },
    });

    const id = await controller.start({ title: "Standup" });
    shell.emitSegment(segment("seg-1", "we should ship it"));
    controller.setNotes(id, "- ship it\n- tell everyone");
    await controller.end();

    const sessions = new Set(shell.writes.map((write) => write.sessionId));
    expect([...sessions]).toEqual([id]);

    const segments = shell.writes.filter((write) => write.kind === "segments");
    const notes = shell.writes.filter((write) => write.kind === "notes");
    const finalizes = shell.writes.filter((write) => write.kind === "finalize");

    expect(
      segments.flatMap((write) => (write.body.segments as { text: string }[]) ?? []).map((one) => one.text),
    ).toContain("we should ship it");
    expect(notes.map((write) => write.body.markdown)).toContain("- ship it\n- tell everyone");
    // Not an empty one before them, which is the race written as an assertion.
    expect(notes.every((write) => write.body.markdown !== "")).toBe(true);
    expect(finalizes).toHaveLength(1);
  });

  test("...and the note path the gateway chose is what the record ends up holding", async () => {
    const shell = writingShell("5-meetings/2026-09-07-standup.md");
    installShell(shell);

    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: meetingsWriterFor(fakeGateway()),
      recorder: await resolveRecorder("web"),
      device: { platform: "web" },
    });
    const id = await controller.start({ title: "Standup" });
    controller.setNotes(id, "- daily standup notes");
    await controller.end();

    const record = controller.getSnapshot().records.find((one) => one.session.id === id);
    expect(record?.session.notePath).toBe("5-meetings/2026-09-07-standup.md");
  });

  /**
   * The parity the decision asks for, stated as one assertion rather than as
   * prose: the writes a console-recorded meeting produces are the meetings
   * protocol's four, addressed the same way the tray's own recording addresses
   * them — same routes, same credential, same queue.
   */
  test("a meeting from the console reaches the queue as the protocol's own four writes", async () => {
    const shell = writingShell();
    installShell(shell);

    const gateway = createDesktopGateway(shell.bridge.meetings!);
    const session = {
      id: "mtg_abcdefghjkmnpqrstvwx",
      state: "finalizing",
      transcript: [segment("seg-1", "hello")],
      startedAt: "2026-09-07T10:00:00.000Z",
    } as never;

    await gateway.putSession(null, session);
    await gateway.putSegments(null, "mtg_abcdefghjkmnpqrstvwx", [segment("seg-1", "hello")]);
    await gateway.putNotes(null, "mtg_abcdefghjkmnpqrstvwx", "my notes");
    await gateway.finalize(null, session);

    expect(shell.writes.map((write) => write.kind)).toEqual([
      "session",
      "segments",
      "notes",
      "finalize",
    ]);
    // The bodies are `createHttpGateway`'s, because this is the same request
    // made with the same credential — the shell is transport, not a protocol.
    expect(shell.writes[1].body).toEqual({ segments: [segment("seg-1", "hello")] });
    expect(shell.writes[2].body).toEqual({ markdown: "my notes" });
    expect(shell.writes[3].body).toEqual({});
    expect(shell.writes.every((write) => write.context === null)).toBe(true);
  });

  test("a destination rides as a context name, never as a path", async () => {
    const shell = writingShell();
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await gateway.putNotes({ kind: "personalInbox" as const, contextSlug: "acme", folder: "5-meetings" }, "mtg_1", "notes");
    expect(shell.writes[0].context).toBe("acme");

    await gateway.finalize(
      { kind: "personalInbox" as const, contextSlug: "acme", folder: "5-meetings" },
      { id: "mtg_1", transcript: [] } as never,
    );
    expect(shell.writes[1].body).toEqual({ folder: "5-meetings" });
  });

  /**
   * A slug the gateway's own selector would not read falls off the front of the
   * path and the request is served by whatever context the credential defaults
   * to — a meeting written into the wrong tenant, in silence. Refusing to send
   * is the only answer that is not that.
   */
  test("A DESTINATION THE GATEWAY WOULD IGNORE IS REFUSED RATHER THAN SENT", async () => {
    const shell = writingShell();
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(
      gateway.putNotes({ kind: "personalInbox" as const, contextSlug: "Acme Corp", folder: "5-meetings" }, "mtg_1", "notes"),
    ).rejects.toBeInstanceOf(MeetingGatewayError);
    expect(shell.writes).toEqual([]);
  });

  /**
   * The rule `docs/decisions/app-and-console.md` states: the UI must never claim
   * a write it has not seen acknowledged. A queued finalize is the shell holding
   * a meeting, not a note in a bucket, so it is a transient refusal — the record
   * keeps asking, and re-finalizing is answered with the note that already
   * exists once it lands.
   */
  test("a finalize the shell has only queued is not an acknowledgement", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(
      gateway.finalize(null, { id: "mtg_1", transcript: [] } as never),
    ).rejects.toMatchObject({ message: DESKTOP_WRITE_SENTENCES.queued });
  });

  test("...and a finalize that landed carries the path the gateway chose", async () => {
    const shell = writingShell("5-meetings/x.md");
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    const ack = await gateway.finalize(null, { id: "mtg_1", transcript: [] } as never);
    expect(ack.notePath).toBe("5-meetings/x.md");
    expect(ack.state).toBe("complete");
    // Nothing was written conditionally, and this ack does not claim it was.
    expect(ack.conflictSafe).toBe(false);
  });

  test("a meeting the shell's queue parked is parked here too, with the shell's sentence", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true },
      write: (write) => ({
        sessionId: write.sessionId,
        queued: false,
        notePath: null,
        rejected: { code: "meeting_forbidden", message: "your context would not take it" },
      }),
    });
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(gateway.putSession(null, { id: "mtg_1", transcript: [] } as never)).rejects.toMatchObject({
      code: "meeting_forbidden",
      message: "your context would not take it",
    });
  });

  test("...and a code this build does not know parks rather than retrying forever", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true },
      write: (write) => ({
        sessionId: write.sessionId,
        queued: false,
        notePath: null,
        rejected: { code: "meeting_teapot", message: "no" },
      }),
    });
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(gateway.putSession(null, { id: "mtg_1", transcript: [] } as never)).rejects.toMatchObject({
      code: "meeting_invalid",
    });
  });

  /* --- which writer, and when it is not this one ------------------------- */

  test("a browser keeps the writer it had", () => {
    const page = fakeGateway();
    expect(meetingsWriterFor(page, null)).toBe(page);
  });

  test("A SHELL OLDER THAN THIS BUNDLE KEEPS IT TOO — version 1 has no `meetings`", () => {
    const page = fakeGateway();
    const old = fakeDesktopBridge({ noMeetings: true, capabilities: { mic: true } });
    expect(old.bridge.version).toBe(1);
    expect(meetingsWriterFor(page, old.bridge)).toBe(page);
  });

  test("...and a shell that offers one does not", () => {
    const page = fakeGateway();
    const shell = writingShell();
    expect(meetingsWriterFor(page, shell.bridge)).not.toBe(page);
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

  test("the desktop integration card exposes iMessage import from the bridge", async () => {
    const shell = fakeDesktopBridge({
      imessage: {
        enabled: false,
        permission: "granted",
        lastSyncedAt: null,
        lastError: null,
      },
    });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(has(mounted.container, "this-machine-imessage")).toBe(true);
    expect(mounted.container.textContent).toContain("iMessage");
    expect(mounted.container.textContent).toContain("Import is off on this Mac.");

    const button = mounted.container.querySelector(
      '[data-testid="this-machine-imessage-toggle"]',
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(shell.imessageSetEnabledCalls).toEqual([true]);

    mounted.unmount();
    expect(shell.listenerCount()).toBe(0);
  });

  /*
    One machine, two settings panels.

    Settings asks about recording under **Meetings** and about Messages under
    **Chats**, because a person looking for their texts does not think
    "meetings". This card is the one place both live, so it takes a `focus`
    rather than being split — and what makes that safe is that the two halves
    are not symmetrical. Both spend the *same* machine grant (`apps/desktop`'s
    iMessage import writes through `write_note` with this machine's token), so
    Chats cannot simply drop the connection state: an unconnected machine is
    precisely why somebody's messages are not arriving.
  */
  const IMESSAGE_SHELL = {
    enabled: false,
    permission: "granted" as const,
    lastSyncedAt: null,
    lastError: null,
  };

  async function machine(focus: "meetings" | "chats" | undefined, shell: FakeDesktopBridge) {
    installShell(shell);
    const mounted = mount(createElement(ThisMachineCard, focus === undefined ? {} : { focus }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return mounted;
  }

  test("Meetings is the machine without the Messages half", async () => {
    const mounted = await machine(
      "meetings",
      fakeDesktopBridge({ imessage: { ...IMESSAGE_SHELL, enabled: true } }),
    );

    expect(has(mounted.container, "this-machine-title")).toBe(true);
    expect(has(mounted.container, "this-machine-imessage")).toBe(false);
    expect(mounted.container.textContent).not.toContain("iMessage");

    mounted.unmount();
  });

  test("Chats keeps Messages and drops the meetings sentence", async () => {
    const mounted = await machine(
      "chats",
      fakeDesktopBridge({
        imessage: IMESSAGE_SHELL,
        connection: {
          state: "connected",
          gateway: "https://gateway.invalid",
          encrypted: true,
          connecting: false,
          error: null,
        },
      }),
    );

    expect(has(mounted.container, "this-machine-imessage")).toBe(true);
    expect(mounted.container.textContent).toContain("Import is off on this Mac.");
    // The machine's own copy is about meetings, because that is what the grant
    // was built for. Under a Chats heading it answers a question nobody asked.
    expect(mounted.container.textContent).not.toContain("Meetings recorded here go to");
    // And Disconnect stops meetings too, so it lives on the panel that says so.
    expect(has(mounted.container, "this-machine-disconnect")).toBe(false);

    mounted.unmount();
  });

  test("...and says an unconnected machine is why nothing is arriving, with the way out", async () => {
    const mounted = await machine("chats", fakeDesktopBridge({ imessage: IMESSAGE_SHELL }));

    expect(mounted.container.textContent).toContain("nothing arrives until it is connected");
    // The one control that unblocks Messages is here, unlike Disconnect.
    expect(has(mounted.container, "this-machine-connect")).toBe(true);

    mounted.unmount();
  });

  test("Chats draws nothing at all where the shell has no Messages support", async () => {
    // A card headed with this Mac's name over one blank line is a worse answer
    // than no card — the same rule the settings sections themselves follow.
    const mounted = await machine("chats", fakeDesktopBridge({ noImessage: true }));

    expect(mounted.container.textContent).toBe("");

    mounted.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE MACHINE THAT CONNECTS ITSELF.
 *
 * The owner, on the first end-to-end desktop capture (2026-09-07): *"I don't
 * love this setup; when installing Granola I didn't have to 'connect' a
 * machine, things just worked."* He was signed in **in this window** and the app
 * still put an approve screen in front of him.
 *
 * So the shell hands this card the request it parked, and the card answers it
 * with the session the page already holds. What is checked here is the page's
 * whole half of that, which is three things a refactor could take away without
 * anything else noticing:
 *
 *  1. **a session means the grant is minted, once, with no screen** — and the
 *     window is sent to the loopback redirect the control plane answered with,
 *     which is where the code reaches the shell's own listener;
 *  2. **no session means the shell is told so**, immediately, because that is
 *     what turns a five-minute wait into the approve screen the console's own
 *     sign-in begins;
 *  3. **nothing credential-shaped crosses either way.** What the page is handed
 *     is a request id; what it hands back is that id and a boolean.
 *
 * And the shape of the estate: a **version-2 shell** — the one that shipped
 * #312's in-window approve screen — has none of these members, and this card
 * has to draw itself against it without calling them.
 *
 * ## Sabotage record
 *
 * Broken deliberately, whole mobile suite run, reverted. Counts are failing
 * tests.
 *
 *   `decideMachineApproval` minting unconditionally                    13
 *   ...ignoring `answered`, so a re-render mints again                  9
 *   ...ignoring `auth.isLoading`                                        2
 *   ...ignoring a connection that is already connected                  2
 *   the card not telling the shell about a refusal                      1
 *   ...not telling it about a success                                   2
 *   the card not navigating to the redirect it was given                1
 *   the refusal line naming what the control plane said                 2
 *   the card seeding a pending approval from `?request_id=`             2
 *
 * The first two are large for the reason the **20** above is: a card that
 * mints on every render mints inside a dozen other tests that merely happen to
 * have a shell installed, and that is the right direction to fail in. The rows
 * that are this block's own are the **1**s and **2**s, each naming a defect
 * nothing else in this app looks at.
 *
 * **The first run of this record measured every row as 0**, and the cause is
 * worth writing down: the counter read the suite's *stdout*, and Jest writes
 * its summary to stderr. A sabotage harness that cannot see a failure reports
 * a guard that does not exist as a guard that is not needed.
 */
describe("this machine connects itself when its owner is already signed in", () => {
  /** Where the page is sent at the end. Asserted, never followed. */
  let navigated: string | null = null;

  beforeEach(() => {
    navigated = null;
    /*
      `leaveTo` is how this app leaves itself, on web through
      `window.location.assign` — so that is what is staged, rather than a
      `href` setter that would pass whatever the card did.
    */
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://context.lc/console",
        assign: (next: string) => {
          navigated = next;
        },
      },
    });
  });

  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  test("A SIGNED-IN CONSOLE MINTS THE GRANT WITH NO APPROVE SCREEN", async () => {
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    expect(mockMintCalls).toEqual([{ requestId: "req_this_mac" }]);
    // The page is on its way to the loopback redirect, which is the one
    // navigation this window is allowed and where the code reaches the shell.
    expect(navigated).toBe(
      "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
    );
    // The shell is told, so it knows the page did not go silent.
    expect(shell.approvals).toEqual([{ requestId: "req_this_mac", approved: true }]);
    // And the card says which context this machine may now write to — the slug
    // the control plane resolved, never the one the console happens to show.
    expect(mounted.container.textContent).toContain("This machine can write to @seyi.");

    mounted.unmount();
  });

  test("...ONCE, however many times the card re-renders", async () => {
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();
    act(() => {
      shell.emitConnection({
        state: "disconnected",
        gateway: null,
        encrypted: true,
        connecting: true,
        error: null,
      });
    });
    await settle();
    act(() => {
      shell.emitPendingApproval({ requestId: "req_this_mac" });
    });
    await settle();

    // A card that re-minted on every push would mint a machine grant per
    // render, which is what the control plane's rate limit would then be
    // protecting this person from rather than an attacker.
    expect(mockMintCalls).toEqual([{ requestId: "req_this_mac" }]);

    mounted.unmount();
  });

  test("A SIGNED-OUT PAGE MINTS NOTHING AND SAYS SO AT ONCE", async () => {
    mockAuthState = { isLoading: false, isAuthenticated: false };
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    expect(mockMintCalls).toEqual([]);
    expect(navigated).toBe(null);
    // Told immediately: the shell answers this by putting the approve screen in
    // this window, and that screen begins with the console's own sign-in.
    expect(shell.approvals).toEqual([{ requestId: "req_this_mac", approved: false }]);

    mounted.unmount();
  });

  test("...and a session that has not resolved yet decides nothing", async () => {
    mockAuthState = { isLoading: true, isAuthenticated: false };
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    // Answering "signed out" for somebody who is signed in costs them a screen
    // they did not need, which is the whole thing this change removes.
    expect(mockMintCalls).toEqual([]);
    expect(shell.approvals).toEqual([]);

    mounted.unmount();
  });

  test("A CONTROL PLANE THAT REFUSES COSTS A SCREEN, NEVER THE GRANT", async () => {
    mockMintAnswer = async () => {
      throw new Error("refused");
    };
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    expect(shell.approvals).toEqual([{ requestId: "req_this_mac", approved: false }]);
    expect(navigated).toBe(null);
    // No sentence about which condition failed: every refusal ends the same way
    // for the person, with the approve screen a moment later.
    expect(mounted.container.textContent).toContain("Asking you to approve this machine");
    expect(mounted.container.textContent).not.toContain("refused");

    mounted.unmount();
  });

  test("a machine that is already connected mints nothing", async () => {
    const shell = fakeDesktopBridge({
      pendingApproval: { requestId: "req_this_mac" },
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
    await settle();

    expect(mockMintCalls).toEqual([]);
    mounted.unmount();
  });

  test("NOTHING CREDENTIAL-SHAPED CROSSES IN EITHER DIRECTION", async () => {
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    // What went back: the id the shell handed over, and a boolean.
    expect(shell.approvals.map((answer) => Object.keys(answer).sort())).toEqual([
      ["approved", "requestId"],
    ]);

    mounted.unmount();
  });

  /*
    THE LINK THE WHOLE FEATURE HANGS FROM.

    `software_id` is client-asserted: anything that can register can claim to be
    the shell, and `docs/decisions/identity-and-access.md` says so out loud. So
    what stops a forged client from getting an auto-approved grant is not the
    declaration — it is that the *request id* only ever reaches this page over
    the shell's bridge. A page at a foreign origin gets no bridge at all
    (`shouldExposeBridge`, in the preload), and a page at this origin reads the
    id from nowhere else: not a query parameter, not the fragment, not a
    `postMessage` from an opener, not a global somebody set.

    That is a property of *this file*, which is why it is checked twice — once
    by driving the card with all three of those in place and no bridge push, and
    once by reading the two source files for the shapes that would make it
    false. The second check is the one that survives a refactor: a future deep
    link that read `?request_id=` into this card would be a confused deputy with
    a signed-in session behind it, and it would go red here rather than in
    production.
  */
  test("A REQUEST ID THAT DID NOT COME OVER THE BRIDGE MINTS NOTHING", async () => {
    // A shell is present — so the card renders and the bridge is live — but it
    // is holding no approval. Everything below is an attacker's delivery route.
    const shell = fakeDesktopBridge({ pendingApproval: null });
    installShell(shell);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://context.lc/console?request_id=req_forged#request_id=req_forged",
        search: "?request_id=req_forged",
        hash: "#request_id=req_forged",
        assign: (next: string) => {
          navigated = next;
        },
      },
    });
    (globalThis as Record<string, unknown>).__pendingApproval = { requestId: "req_forged" };

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    window.postMessage({ requestId: "req_forged" }, "*");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { pendingApproval: { requestId: "req_forged" } },
        origin: "https://attacker.invalid",
      }),
    );
    await settle();

    expect(mockMintCalls).toEqual([]);
    expect(shell.approvals).toEqual([]);
    expect(navigated).toBe(null);
    expect(has(mounted.container, "this-machine-approval")).toBe(false);

    mounted.unmount();
    delete (globalThis as Record<string, unknown>).__pendingApproval;
  });

  test("...and neither source file has a second way to learn one", () => {
    const sources = [
      "../features/meetings/machineApproval.ts",
      "../features/meetings/components/ThisMachineCard.tsx",
    ].map((path) => readFileSync(join(__dirname, path), "utf8"));

    for (const source of sources) {
      // Every shape that would let something other than the shell name the
      // request this page answers.
      expect(source).not.toMatch(/location|URLSearchParams|useLocalSearchParams|useSearchParams/);
      expect(source).not.toMatch(/postMessage|"message"|'message'|window\.opener|referrer/);
    }
    // And the one member it does read it from, named so a rename is a red test
    // rather than a silent widening.
    expect(sources[1]).toMatch(/connection\.pendingApproval\(\)/);
  });

  test("A VERSION-2 SHELL IS DRAWN WITHOUT CALLING MEMBERS IT NEVER PROMISED", async () => {
    const shell = fakeDesktopBridge({ noMachineApproval: true });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    // It approves in its own window, which is what #312 shipped, and this card
    // draws exactly what it drew then.
    expect(has(mounted.container, "this-machine-title")).toBe(true);
    expect(has(mounted.container, "this-machine-approval")).toBe(false);
    expect(mockMintCalls).toEqual([]);

    mounted.unmount();
    expect(shell.listenerCount()).toBe(0);
  });

  test("the subscription detaches with the pane, like every other one", async () => {
    const shell = fakeDesktopBridge();
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();
    expect(shell.listenerCount()).toBeGreaterThan(0);

    mounted.unmount();
    expect(shell.listenerCount()).toBe(0);
  });
});
