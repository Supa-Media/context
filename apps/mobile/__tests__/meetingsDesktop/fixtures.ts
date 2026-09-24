import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { FakeDesktopBridge } from "@context/desktop-bridge/fake";

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
 *   `desktopRecorder` not detaching on stop                                   4
 *   `attach()` not detaching the previous subscriptions first                 1
 *   only the segment subscription released, not the capture-state one         4
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
 *
 * ## Why the convex/react mock is not here
 *
 * Only `listAndLiveScreen`-style files that mount `ThisMachineCard` need
 * `jest.mock("convex/react", ...)`, and its factory reads `mockAuthState` /
 * `mockMintCalls` / `mockMintAnswer` as plain locals — the same reason
 * `meetingsScreens/fixtures.ts` keeps `pushed`/`mockPathname` out of the
 * shared module. Routing them through here would nest a still-loading
 * `import ... from "./fixtures"` inside the factory it registers. Each file
 * that needs it declares its own three lets and its own `jest.mock` call,
 * right before requiring `ThisMachineCard` (also required per file, for the
 * same reason).
 */

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
export const desktopState = {
  recorderInstances: 0,
  getUserMediaCalls: 0,
};

export class FakeTrack extends EventTarget {
  readonly kind = "audio";
  stop(): void {}
}

export function installBrowser(): void {
  class FakeMediaRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
      desktopState.recorderInstances += 1;
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
        desktopState.getUserMediaCalls += 1;
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
export function installShell(fake: FakeDesktopBridge): void {
  (globalThis as Record<string, unknown>).desktop = fake.bridge;
}

export function removeShell(): void {
  delete (globalThis as Record<string, unknown>).desktop;
}

export function mount(element: ReactElement) {
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

export const has = (container: HTMLElement, testId: string): boolean =>
  container.querySelector(`[data-testid="${testId}"]`) !== null;

/* eslint-disable @typescript-eslint/no-require-imports */
export const { resolveRecorder } =
  require("../../features/meetings/capture/audio.web") as typeof import("../../features/meetings/capture/audio.web");
export const { DESKTOP_MESSAGES } =
  require("../../features/meetings/capture/desktop") as typeof import("../../features/meetings/capture/desktop");
export const { fakeRecorder } =
  require("../../features/meetings/capture/fake") as typeof import("../../features/meetings/capture/fake");
export const { setTranscriber, fakeTranscriber } =
  require("../../features/meetings/capture/transcriber") as typeof import("../../features/meetings/capture/transcriber");
export const { MeetingsController } =
  require("../../features/meetings/controller") as typeof import("../../features/meetings/controller");
export const { memoryStore } =
  require("../../features/offline/memory") as typeof import("../../features/offline/memory");
export const { fakeGateway } =
  require("../../features/meetings/fakeGateway") as typeof import("../../features/meetings/fakeGateway");
export const { MIC_ONLY_SENTENCE } =
  require("../../features/meetings/disclosure") as typeof import("../../features/meetings/disclosure");
export const { defaultMachineAudio, recallMachineAudio, rememberMachineAudio, recallSystemAudio } =
  require("../../features/meetings/machineAudio") as typeof import("../../features/meetings/machineAudio");
export const { describeMachine, machineTitle } =
  require("../../features/meetings/thisMachine") as typeof import("../../features/meetings/thisMachine");
export const { createDesktopGateway, meetingsWriterFor, DESKTOP_WRITE_SENTENCES } =
  require("../../features/meetings/desktopGateway") as typeof import("../../features/meetings/desktopGateway");
export const { MeetingGatewayError } =
  require("../../features/meetings/gateway") as typeof import("../../features/meetings/gateway");
/* eslint-enable @typescript-eslint/no-require-imports */

/** The `beforeEach` every file in this folder runs. */
export function resetDesktop(): void {
  document.body.replaceChildren();
  desktopState.recorderInstances = 0;
  desktopState.getUserMediaCalls = 0;
  installBrowser();
  removeShell();
  setTranscriber(fakeTranscriber());
}

/** The `afterEach` every file in this folder runs. */
export function teardownDesktop(): void {
  removeShell();
  setTranscriber(null);
}
