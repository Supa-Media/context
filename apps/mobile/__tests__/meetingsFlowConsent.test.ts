/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  CLOUD_TRANSCRIPTION_CONSENT_VERSION,
  TRANSCRIPTION_CONSENT_COPY,
} from "@context/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The cloud transcription question, in front of the press that would send
 * audio (`docs/decisions/meetings/transcription-consent.md`).
 *
 * App Review rejected the build under 5.1.1(i) and 5.1.2(i): a microphone
 * permission is not permission to send a recording to Cloudflare Workers AI.
 * So a New meeting whose recorder transcribes in the cloud, pressed by an
 * account with no current yes, shows the dialog first and starts nothing until
 * it is answered. Allow saves the yes on the account before anything starts;
 * Not now saves nothing and still opens the notepad, and the recorder, finding
 * no yes, opens no microphone (`meetingsCapture/consent.test.ts` proves that
 * half).
 *
 * ## Sabotage record
 *
 * Each applied, suite run, named test failed, reverted.
 *
 *  1. `gate` runs the start without asking (`needsTranscriptionConsent` → false).
 *     → `the question comes before the recorder is touched` fails.
 *  2. Not now calls `allowTranscription`.
 *     → `Not now saves nothing and leaves a notes-only meeting` fails.
 *  3. Allow starts before the mutation settles (`finish()` moved above it).
 *     → `a yes that did not save starts nothing` fails.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}));

const mockMutations: Array<{ name: string; args: unknown }> = [];
let mockMutationFails = false;
jest.mock("convex/react", () => {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const actual = jest.requireActual("convex/react") as Record<string, unknown>;
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const client = {
    mutation: async (ref: unknown, args: unknown) => {
      mockMutations.push({ name: getFunctionName(ref as never), args });
      if (mockMutationFails) throw new Error("offline");
      return null;
    },
  };
  return { ...actual, useConvex: () => client };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { useMeetingFlow } =
  require("../features/meetings/useMeetingFlow") as typeof import("../features/meetings/useMeetingFlow");
const { meetings } =
  require("../features/meetings/controller") as typeof import("../features/meetings/controller");
const { fakeGateway } =
  require("../features/meetings/fakeGateway") as typeof import("../features/meetings/fakeGateway");
const { fakeRecorder } =
  require("../features/meetings/capture/fake") as typeof import("../features/meetings/capture/fake");
const { cloudTranscriptionAllowed, setTranscriptionConsent } =
  require("../features/meetings/capture") as typeof import("../features/meetings/capture");
const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
const { CONSENT_NOT_SAVED } =
  require("../features/meetings/useTranscriptionConsent") as typeof import("../features/meetings/useTranscriptionConsent");
/* eslint-enable @typescript-eslint/no-require-imports */

type Recorder = ReturnType<typeof fakeRecorder>;

const OWN = { slug: "testagent1", kind: "personal", role: "owner" };
const ALLOW = "functions/transcriptionConsent:allowTranscription";

function Harness(props: Parameters<typeof useMeetingFlow>[0]): ReactElement {
  const flow = useMeetingFlow(props);
  return createElement(
    "div",
    null,
    createElement("button", { "data-testid": "new-meeting", onClick: flow.startMeetingFlow }, "+"),
    flow.sheet,
  );
}

function mount(element: ReactElement): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return () => {
    act(() => root.unmount());
    host.remove();
  };
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

/** A recorder that sends its audio to the cloud, which is what needs the yes. */
async function configureCloud(): Promise<Recorder> {
  const recorder = fakeRecorder({ audio: true, transcribesAt: "cloud" });
  await act(async () => {
    meetings.reset();
    await meetings.configure({
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder,
      device: { platform: "web" },
      persistDebounceMs: 0,
    });
  });
  return recorder;
}

beforeEach(() => {
  document.body.replaceChildren();
  mockMutations.length = 0;
  mockMutationFails = false;
  setTranscriptionConsent(null);
});

afterEach(() => {
  setTranscriptionConsent(null);
});

describe("the question comes first", () => {
  test("the question comes before the recorder is touched", async () => {
    const recorder = await configureCloud();
    const unmount = mount(createElement(Harness, { contexts: [OWN] }));
    await settle();

    press("new-meeting");
    await settle();

    expect(shown("transcription-consent")).toBe(true);
    const words = document.body.textContent ?? "";
    expect(words).toContain(TRANSCRIPTION_CONSENT_COPY.title);
    expect(words).toContain(TRANSCRIPTION_CONSENT_COPY.body);
    expect(words).toContain(TRANSCRIPTION_CONSENT_COPY.allow);
    expect(words).toContain(TRANSCRIPTION_CONSENT_COPY.decline);
    expect(shown("transcription-consent-privacy")).toBe(true);
    expect(recorder.calls).not.toContain("start");
    expect(meetings.getSnapshot().live).toBeNull();
    unmount();
  });

  test("Allow saves the yes for this disclosure, then starts", async () => {
    const recorder = await configureCloud();
    const unmount = mount(createElement(Harness, { contexts: [OWN] }));
    await settle();

    press("new-meeting");
    await settle();
    press("transcription-consent-allow");
    await settle();

    expect(mockMutations).toEqual([{ name: ALLOW, args: { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION } }]);
    expect(cloudTranscriptionAllowed()).toBe(true);
    expect(recorder.calls).toContain("start");
    expect(shown("transcription-consent")).toBe(false);
    unmount();
  });

  test("Not now saves nothing and leaves a notes-only meeting", async () => {
    await configureCloud();
    const unmount = mount(createElement(Harness, { contexts: [OWN] }));
    await settle();

    press("new-meeting");
    await settle();
    press("transcription-consent-decline");
    await settle();

    expect(mockMutations).toEqual([]);
    expect(cloudTranscriptionAllowed()).toBe(false);
    // The notepad still opens: the person can type.
    expect(meetings.getSnapshot().live).not.toBeNull();
    expect(shown("transcription-consent")).toBe(false);
    unmount();
  });

  test("a yes that did not save starts nothing", async () => {
    const recorder = await configureCloud();
    mockMutationFails = true;
    const unmount = mount(createElement(Harness, { contexts: [OWN] }));
    await settle();

    press("new-meeting");
    await settle();
    press("transcription-consent-allow");
    await settle();

    expect(cloudTranscriptionAllowed()).toBe(false);
    expect(recorder.calls).not.toContain("start");
    expect(document.body.textContent).toContain(CONSENT_NOT_SAVED);
    unmount();
  });

  test("an account that already said yes is not asked again", async () => {
    const recorder = await configureCloud();
    setTranscriptionConsent(CLOUD_TRANSCRIPTION_CONSENT_VERSION);
    const unmount = mount(createElement(Harness, { contexts: [OWN] }));
    await settle();

    press("new-meeting");
    await settle();

    expect(shown("transcription-consent")).toBe(false);
    expect(recorder.calls).toContain("start");
    unmount();
  });

  test("a recorder that hears on the device is never asked about the cloud", async () => {
    const recorder = fakeRecorder({ audio: true, transcribesAt: "device" });
    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-1",
        store: memoryStore(),
        gateway: fakeGateway(),
        recorder,
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });
    const unmount = mount(createElement(Harness, { contexts: [OWN] }));
    await settle();

    press("new-meeting");
    await settle();

    expect(shown("transcription-consent")).toBe(false);
    expect(recorder.calls).toContain("start");
    unmount();
  });
});
